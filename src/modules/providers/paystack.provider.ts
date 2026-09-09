import crypto from 'crypto';
import { PaymentStatus, RefundStatus } from '@prisma/client';
import {
  IPaymentProvider,
  CreatePaymentRequest,
  NormalizedPaymentResponse,
  CreatePayoutRequest,
  NormalizedPayoutResponse,
  CreateRefundRequest,
  NormalizedRefundResponse,
  WebhookEventPayload,
  PaymentInstruction,
} from './paymentProvider.interface.js';
import { WebhookVerificationError, BadRequestError, ProviderError } from '../../errors/index.js';
import { PaystackClient } from '../../services/paystack.client.js';
import { config } from '../../config/index.js';

export class PaystackNgnPaymentProvider implements IPaymentProvider {
  public readonly providerId = 'PAYSTACK_NGN_BANK_TRANSFER';
  public readonly supportedCurrencies = ['NGN'];

  private client: PaystackClient;
  private secretKeyOverride?: string;

  constructor(client?: PaystackClient, secretKey?: string) {
    this.client = client || new PaystackClient();
    this.secretKeyOverride = secretKey;
  }

  public async createPayment(request: CreatePaymentRequest): Promise<NormalizedPaymentResponse> {
    if (request.currency !== 'NGN') {
      throw new BadRequestError(`PaystackNgnPaymentProvider only supports NGN currency, received: ${request.currency}`);
    }

    const numericAmount = parseFloat(request.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      throw new BadRequestError(`Invalid payment amount for NGN deposit: ${request.amount}`);
    }

    const amountInKobo = Math.round(numericAmount * 100);

    // Call Paystack TEST MODE API to initialize transaction
    const initRes = await this.client.initializeTransaction({
      amountInKobo,
      email: (request.metadata?.userEmail as string) || 'customer@luminarail.com',
      reference: request.reference,
      currency: 'NGN',
    });

    const instructions: PaymentInstruction = {
      bankName: 'Paystack Test Mode Checkout',
      reference: request.reference,
      amount: request.amount,
      currency: 'NGN',
      paymentUrl: initRes.authorizationUrl,
      instructions: 'Complete Paystack TEST MODE payment via dynamic test bank transfer or test card.',
    };

    return {
      provider: this.providerId,
      providerPaymentId: initRes.reference,
      status: PaymentStatus.PENDING,
      amount: request.amount,
      currency: request.currency,
      instructions,
      redirectUrl: initRes.authorizationUrl,
      metadata: {
        railType: 'PAYSTACK_TEST_CHECKOUT',
        paymentUrl: initRes.authorizationUrl,
        accessCode: initRes.accessCode,
        reference: request.reference,
        isTestMode: true,
      },
      rawResponse: initRes,
    };
  }

  public async getPaymentStatus(providerPaymentId: string): Promise<NormalizedPaymentResponse> {
    return this.verifyPayment(providerPaymentId);
  }

  public async verifyPayment(
    providerPaymentId: string,
    params?: Record<string, unknown>
  ): Promise<NormalizedPaymentResponse> {
    const verifyRes = await this.client.verifyTransaction(providerPaymentId);

    let status: PaymentStatus = PaymentStatus.PENDING;

    if (verifyRes.status === 'success') {
      status = PaymentStatus.SUCCEEDED;
    } else if (verifyRes.status === 'failed' || verifyRes.status === 'abandoned') {
      status = PaymentStatus.FAILED;
    }

    // Verify expected amount in kobo if provided in params or expected metadata
    if (params?.expectedAmount) {
      const expectedAmountKobo = Math.round(parseFloat(params.expectedAmount as string) * 100);
      if (verifyRes.amountInKobo !== expectedAmountKobo) {
        status = PaymentStatus.FAILED;
      }
    }

    // Verify currency
    if (verifyRes.currency !== 'NGN') {
      status = PaymentStatus.FAILED;
    }

    const numericAmount = (verifyRes.amountInKobo / 100).toFixed(4);

    return {
      provider: this.providerId,
      providerPaymentId: verifyRes.reference || providerPaymentId,
      status,
      amount: numericAmount,
      currency: verifyRes.currency,
      metadata: {
        paystackTransactionId: verifyRes.id,
        channel: verifyRes.channel,
        customerEmail: verifyRes.customerEmail,
        paidAt: verifyRes.paidAt,
        verifiedAt: new Date().toISOString(),
      },
      rawResponse: verifyRes.raw,
    };
  }

  public async createPayout(request: CreatePayoutRequest): Promise<NormalizedPayoutResponse> {
    const providerPayoutId = `pstk_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return {
      provider: this.providerId,
      providerPayoutId,
      status: PaymentStatus.PROCESSING,
      amount: request.amount,
      currency: request.currency,
      metadata: { reference: request.reference },
      rawResponse: { providerPayoutId },
    };
  }

  public async getPayoutStatus(providerPayoutId: string): Promise<NormalizedPayoutResponse> {
    return {
      provider: this.providerId,
      providerPayoutId,
      status: PaymentStatus.SUCCEEDED,
      amount: '0.0000',
      currency: 'NGN',
    };
  }

  public async processRefund(request: CreateRefundRequest): Promise<NormalizedRefundResponse> {
    const numericAmount = parseFloat(request.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      throw new BadRequestError(`Invalid refund amount: ${request.amount}`);
    }
    const amountInKobo = Math.round(numericAmount * 100);

    try {
      const refundRes = await this.client.refundTransaction({
        transaction: request.paymentReference,
        amountInKobo,
        merchantNote: request.reason,
      });

      let status: RefundStatus = RefundStatus.PROCESSING;
      if (refundRes.status === 'processed' || refundRes.status === 'success' || refundRes.status === 'successful') {
        status = RefundStatus.SUCCEEDED;
      } else if (refundRes.status === 'pending' || refundRes.status === 'processing') {
        status = RefundStatus.PROCESSING;
      } else if (refundRes.status === 'failed') {
        status = RefundStatus.FAILED;
      }

      return {
        provider: this.providerId,
        providerRefundId: String(refundRes.id),
        status,
        amount: request.amount,
        currency: request.currency,
        metadata: {
          transactionReference: refundRes.transactionReference,
          processedAt: new Date().toISOString(),
        },
        rawResponse: refundRes.raw,
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.message.includes('Network Error')) {
          // Return PROCESSING status with ambiguous error metadata so it is not marked FAILED or retried blindly
          return {
            provider: this.providerId,
            providerRefundId: `ambiguous_${Date.now()}`,
            status: RefundStatus.PROCESSING,
            amount: request.amount,
            currency: request.currency,
            failureReason: err.message,
            metadata: { ambiguousNetworkFailure: true },
          };
        }
        return {
          provider: this.providerId,
          providerRefundId: `failed_${Date.now()}`,
          status: RefundStatus.FAILED,
          amount: request.amount,
          currency: request.currency,
          failureReason: err.message,
        };
      }
      throw err;
    }
  }

  public verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string | Buffer
  ): boolean {
    const sigHeader =
      headers['x-paystack-signature'] ||
      headers['X-Paystack-Signature'] ||
      headers['x-ngn-signature'] ||
      headers['X-NGN-Signature'];

    if (!sigHeader) {
      return false;
    }

    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    // Secret Key HMAC SHA512 Verification
    const secret = this.secretKeyOverride || process.env.PAYSTACK_SECRET_KEY || config.paystack.secretKey;
    if (!secret) {
      return false;
    }

    try {
      const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody;
      const computedHex = crypto
        .createHmac('sha512', secret)
        .update(bodyBuffer)
        .digest('hex');

      const bufComputed = Buffer.from(computedHex, 'utf-8');
      const bufSignature = Buffer.from(signature, 'utf-8');

      if (bufComputed.length !== bufSignature.length) {
        return false;
      }

      return crypto.timingSafeEqual(bufComputed, bufSignature);
    } catch {
      return false;
    }
  }

  public parseWebhookEvent(
    headers: Record<string, string | string[] | undefined>,
    body: any,
    rawBody?: string | Buffer
  ): WebhookEventPayload {
    const signatureBody = rawBody || (typeof body === 'string' ? body : JSON.stringify(body));
    if (!this.verifyWebhookSignature(headers, signatureBody)) {
      throw new WebhookVerificationError('Invalid Paystack webhook signature');
    }

    let eventId: string;
    if (body?.id !== undefined && body?.id !== null && String(body.id).trim() !== '') {
      eventId = String(body.id);
    } else if (body?.data?.id !== undefined && body?.data?.id !== null && String(body.data.id).trim() !== '') {
      eventId = String(body.data.id);
    } else {
      const rawType = body?.event || 'charge.success';
      const rawRef = body?.data?.reference || body?.data?.provider_payment_id || 'unknown_ref';
      const rawPaidAt = body?.data?.paid_at || body?.data?.createdAt || '';
      const rawAmount = body?.data?.amount || '';

      const seed = `${rawType}:${rawRef}:${rawPaidAt}:${rawAmount}`;
      const hash = crypto.createHash('sha256').update(seed).digest('hex').substring(0, 16);
      eventId = `evt_pstk_${hash}`;
    }

    const eventType = body?.event || 'charge.success';
    const providerPaymentId = body?.data?.reference || body?.data?.provider_payment_id;

    let status: PaymentStatus = PaymentStatus.PENDING;
    const rawStatus = (body?.data?.status || body?.status || '').toString().toLowerCase();

    if (eventType === 'charge.success' && rawStatus === 'success') {
      status = PaymentStatus.SUCCEEDED;
    } else if (eventType === 'charge.failed' || rawStatus === 'failed') {
      status = PaymentStatus.FAILED;
    }

    return {
      eventId,
      eventType,
      providerPaymentId,
      status,
      payload: body,
    };
  }
}
