import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { WebhookVerificationError } from '../../errors/index.js';
import { PaymentProviderRegistry } from '../providers/provider.registry.js';
import { PaymentStateMachine } from '../payments/payment.state-machine.js';
import { AuditService } from '../audit/audit.service.js';

export class WebhookService {
  public static async processWebhook(
    providerName: string,
    headers: Record<string, string | string[] | undefined>,
    body: any,
    rawBody: string,
    ipAddress?: string
  ) {
    const provider = PaymentProviderRegistry.get(providerName);

    // Step 1: Signature Verification
    const isSignatureValid = provider.verifyWebhookSignature(headers, rawBody);

    await AuditService.log({
      action: 'WEBHOOK_RECEIVED',
      resource: 'WebhookEvent',
      details: {
        provider: providerName,
        signatureVerified: isSignatureValid,
      },
      ipAddress,
    });

    if (!isSignatureValid) {
      throw new WebhookVerificationError(`Invalid webhook signature for provider: ${providerName}`);
    }

    // Step 2: Parse Webhook Event
    const parsedEvent = provider.parseWebhookEvent(headers, body);

    // Step 3: Atomic Transactional Event Claiming
    let webhookEventRecord;
    try {
      webhookEventRecord = await prisma.webhookEvent.create({
        data: {
          provider: provider.providerId,
          eventId: parsedEvent.eventId,
          eventType: parsedEvent.eventType,
          signatureVerified: true,
          processed: false,
          payload: JSON.stringify(parsedEvent.payload),
        },
      });
    } catch (err: any) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existingEvent = await prisma.webhookEvent.findUnique({
          where: {
            provider_eventId: {
              provider: provider.providerId,
              eventId: parsedEvent.eventId,
            },
          },
        });

        if (existingEvent && existingEvent.processed) {
          await AuditService.log({
            action: 'WEBHOOK_DUPLICATE',
            resource: 'WebhookEvent',
            resourceId: existingEvent.id,
            details: {
              provider: provider.providerId,
              eventId: parsedEvent.eventId,
            },
            ipAddress,
          });

          return {
            success: true,
            message: 'Duplicate webhook event already processed',
            duplicate: true,
            eventId: parsedEvent.eventId,
          };
        }

        return {
          success: true,
          message: 'Webhook event is currently being processed',
          duplicate: true,
          eventId: parsedEvent.eventId,
        };
      }
      throw err;
    }

    // Step 4: Unambiguous Payment Lookup & State Transition
    if (parsedEvent.providerPaymentId) {
      const payment = await prisma.payment.findFirst({
        where: {
          provider: provider.providerId,
          OR: [
            { providerPaymentId: parsedEvent.providerPaymentId },
            { reference: parsedEvent.providerPaymentId },
          ],
        },
      });

      if (payment && PaymentStateMachine.canTransition(payment.status, parsedEvent.status)) {
        await prisma.$transaction(async (tx) => {
          const updateCount = await tx.payment.updateMany({
            where: {
              id: payment.id,
              status: payment.status,
            },
            data: { status: parsedEvent.status },
          });

          if (updateCount.count > 0) {
            await tx.providerTransaction.updateMany({
              where: { paymentId: payment.id },
              data: { status: parsedEvent.status },
            });

            // Order State Machine Update: Stop at SETTLEMENT_PENDING
            if (parsedEvent.status === PaymentStatus.SUCCEEDED) {
              await tx.order.update({
                where: { id: payment.orderId },
                data: { status: OrderStatus.SETTLEMENT_PENDING },
              });
            } else if (parsedEvent.status === PaymentStatus.FAILED) {
              await tx.order.update({
                where: { id: payment.orderId },
                data: { status: OrderStatus.FAILED },
              });
            }
          }
        });
      }
    }

    // Step 5: Mark Webhook Event Processed Only After Payment Update Succeeds
    await prisma.webhookEvent.update({
      where: { id: webhookEventRecord.id },
      data: {
        processed: true,
        processedAt: new Date(),
      },
    });

    await AuditService.log({
      action: 'WEBHOOK_PROCESSED',
      resource: 'WebhookEvent',
      resourceId: webhookEventRecord.id,
      details: {
        provider: provider.providerId,
        eventId: parsedEvent.eventId,
        eventType: parsedEvent.eventType,
        status: parsedEvent.status,
      },
      ipAddress,
    });

    return {
      success: true,
      message: 'Webhook processed successfully',
      duplicate: false,
      eventId: parsedEvent.eventId,
    };
  }
}
