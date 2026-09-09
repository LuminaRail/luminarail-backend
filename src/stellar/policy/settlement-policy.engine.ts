import {
  Address,
  Operation,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { OrderStatus, PaymentStatus, LiquidityReservationStatus, SettlementStatus, RefundStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { config } from '../../config/index.js';
import { stellarConfig } from '../config/index.js';
import { ISettlementPolicyEngine } from './policy.interface.js';
import { SignTransactionRequest } from '../signer/types.js';
import { SorobanSubmissionError } from '../../errors/index.js';
import { AuditService } from '../../modules/audit/audit.service.js';
import { parseAmountToStroops, parseSettlementIdToU64 } from '../soroban/transaction.service.js';

export class SettlementPolicyEngine implements ISettlementPolicyEngine {
  public async validateAndApprove(request: SignTransactionRequest): Promise<void> {
    const { unsignedTransactionXdr, context } = request;

    // 1. Emergency Pause Check
    if (config.treasury.emergencyGlobalPause) {
      await this.logRejection(context, 'EMERGENCY_GLOBAL_PAUSE_ACTIVE', 'Global settlement pause is active.');
      throw new SorobanSubmissionError('Policy Violation: Emergency global settlement pause is active.');
    }

    // 2. Parse Transaction XDR
    let transaction;
    try {
      transaction = TransactionBuilder.fromXDR(unsignedTransactionXdr, stellarConfig.passphrase);
    } catch (err) {
      await this.logRejection(context, 'MALFORMED_XDR', 'Failed to parse unsigned transaction XDR.');
      throw new SorobanSubmissionError('Policy Violation: Malformed transaction XDR envelope.', err);
    }

    // 3. Network Passphrase Assertion
    if (transaction.networkPassphrase !== stellarConfig.passphrase) {
      await this.logRejection(context, 'NETWORK_PASSPHRASE_MISMATCH', 'Network passphrase mismatch.');
      throw new SorobanSubmissionError('Policy Violation: Stellar network passphrase mismatch.');
    }

    // 4. Operation Type Assertion (Must be a single Soroban InvokeHostFunction)
    if (transaction.operations.length !== 1) {
      await this.logRejection(context, 'INVALID_OPERATION_COUNT', 'Transaction must contain exactly one operation.');
      throw new SorobanSubmissionError('Policy Violation: Settlement transaction must contain exactly one operation.');
    }

    const op = transaction.operations[0];
    if (op.type !== 'invokeHostFunction') {
      await this.logRejection(context, 'INVALID_OPERATION_TYPE', 'Operation must be invokeHostFunction.');
      throw new SorobanSubmissionError('Policy Violation: Transaction operation must be a Soroban invokeHostFunction.');
    }

    // 5. Inspect Soroban Contract Call Parameters
    const invokeOp = op as Operation.InvokeHostFunction;
    const hostFunction = invokeOp.func;

    if (hostFunction.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      await this.logRejection(context, 'INVALID_HOST_FUNCTION', 'Host function must be invokeContract.');
      throw new SorobanSubmissionError('Policy Violation: Soroban operation is not a contract invocation.');
    }

    const invokeContractArgs = hostFunction.invokeContract();
    const targetContractAddress = Address.fromScAddress(invokeContractArgs.contractAddress()).toString();
    const functionName = invokeContractArgs.functionName().toString('utf-8');
    const args = invokeContractArgs.args();

    // 6. Contract ID Whitelist Assertion
    const expectedContractId = context.expectedVaultContract || config.stellar.settlementVaultContractId;
    if (!expectedContractId || targetContractAddress !== expectedContractId) {
      await this.logRejection(context, 'UNAPPROVED_CONTRACT', `Target contract ${targetContractAddress} is not approved.`);
      throw new SorobanSubmissionError(`Policy Violation: Contract address ${targetContractAddress} does not match approved vault contract.`);
    }

    // 7. Function Name Assertion
    if (functionName !== 'create_settlement') {
      await this.logRejection(context, 'UNAPPROVED_FUNCTION', `Function ${functionName} is not create_settlement.`);
      throw new SorobanSubmissionError(`Policy Violation: Contract function ${functionName} is not authorized.`);
    }

    // 8. Soroban Argument Unpacking
    if (args.length !== 5) {
      await this.logRejection(context, 'INVALID_ARGUMENT_COUNT', 'create_settlement requires exactly 5 arguments.');
      throw new SorobanSubmissionError('Policy Violation: create_settlement requires 5 arguments.');
    }

    const argSettlementIdScVal = args[0];
    const argSourceScVal = args[1];
    const argDestinationScVal = args[2];
    const argAssetScVal = args[3];
    const argAmountScVal = args[4];

    const xdrSettlementIdBigInt = scValToNative(argSettlementIdScVal);
    const xdrSourceAddress = Address.fromScVal(argSourceScVal).toString();
    const xdrDestinationAddress = Address.fromScVal(argDestinationScVal).toString();
    const xdrAssetAddress = Address.fromScVal(argAssetScVal).toString();
    const xdrAmountStroops = scValToNative(argAmountScVal);

    // 9. Argument Identity Checks
    const expectedSettlementIdBigInt = parseSettlementIdToU64(context.settlementId);
    if (BigInt(xdrSettlementIdBigInt) !== expectedSettlementIdBigInt) {
      await this.logRejection(context, 'SETTLEMENT_ID_MISMATCH', 'Settlement ID in XDR does not match context.');
      throw new SorobanSubmissionError('Policy Violation: Settlement ID in transaction XDR does not match order context.');
    }

    const expectedSource = context.expectedSource || config.stellar.signerPublicKey;
    if (expectedSource && xdrSourceAddress !== expectedSource) {
      await this.logRejection(context, 'SOURCE_ADDRESS_MISMATCH', 'Source treasury address mismatch.');
      throw new SorobanSubmissionError('Policy Violation: Transaction source address does not match hot treasury wallet.');
    }

    const expectedAsset = context.expectedAssetContract || stellarConfig.usdcContractId;
    if (expectedAsset && xdrAssetAddress !== expectedAsset) {
      await this.logRejection(context, 'ASSET_CONTRACT_MISMATCH', 'Asset contract address mismatch.');
      throw new SorobanSubmissionError('Policy Violation: Transaction asset contract does not match approved USDC contract.');
    }

    // 10. Authoritative Database Order Verification
    const order = await prisma.order.findUnique({
      where: { id: context.orderId },
      include: {
        payments: true,
        reservation: true,
        settlements: true,
      },
    });

    if (!order) {
      await this.logRejection(context, 'ORDER_NOT_FOUND', 'Referenced order not found in database.');
      throw new SorobanSubmissionError(`Policy Violation: Order ${context.orderId} does not exist.`);
    }

    if (order.status !== OrderStatus.SETTLEMENT_PENDING) {
      await this.logRejection(context, 'INVALID_ORDER_STATUS', `Order status is ${order.status}, expected SETTLEMENT_PENDING.`);
      throw new SorobanSubmissionError(`Policy Violation: Order state must be SETTLEMENT_PENDING (actual: ${order.status}).`);
    }

    // Active refund check
    const activeRefund = await prisma.refund.findFirst({
      where: {
        orderId: context.orderId,
        status: { in: [RefundStatus.PENDING, RefundStatus.PROCESSING, RefundStatus.SUCCEEDED] },
      },
    });

    if (activeRefund) {
      await this.logRejection(context, 'ACTIVE_REFUND_PRESENT', 'Order has an active or completed refund.');
      throw new SorobanSubmissionError('Policy Violation: Order has an active or completed refund record.');
    }

    if (!order.walletAddress || StrKey.isValidEd25519PublicKey(order.walletAddress) === false) {
      await this.logRejection(context, 'INVALID_ORDER_WALLET', 'Order destination wallet address is invalid.');
      throw new SorobanSubmissionError('Policy Violation: Order does not contain a valid destination wallet address.');
    }

    if (xdrDestinationAddress !== order.walletAddress) {
      await this.logRejection(context, 'DESTINATION_MISMATCH', 'Destination in XDR does not match Order.walletAddress.');
      throw new SorobanSubmissionError('Policy Violation: Transaction destination address does not match order recipient address.');
    }

    // 11. Exact Amount Verification
    const expectedStroops = parseAmountToStroops(order.destinationAmount.toString());
    if (BigInt(xdrAmountStroops) !== expectedStroops) {
      await this.logRejection(context, 'AMOUNT_MISMATCH', `XDR stroops (${xdrAmountStroops}) mismatch order (${expectedStroops}).`);
      throw new SorobanSubmissionError('Policy Violation: Transaction amount stroops does not match authoritative order destination amount.');
    }

    // 12. Payment & Reservation State Assertions
    const successfulPayment = order.payments.find((p) => p.status === PaymentStatus.SUCCEEDED);
    if (!successfulPayment) {
      await this.logRejection(context, 'NO_SUCCEEDED_PAYMENT', 'Order has no succeeded payment record.');
      throw new SorobanSubmissionError('Policy Violation: Order does not have a confirmed succeeded payment.');
    }

    const reservation = order.reservation;
    if (!reservation || reservation.status !== LiquidityReservationStatus.CONFIRMED) {
      await this.logRejection(context, 'INVALID_RESERVATION_STATUS', 'Liquidity reservation is not confirmed.');
      throw new SorobanSubmissionError('Policy Violation: Order does not possess a confirmed liquidity reservation.');
    }

    // 13. Settlement State Assertion
    const existingSettlement = await prisma.settlement.findUnique({
      where: { orderId: context.orderId },
    });

    if (!existingSettlement) {
      await this.logRejection(context, 'SETTLEMENT_RECORD_MISSING', 'Settlement record missing in database.');
      throw new SorobanSubmissionError('Policy Violation: Settlement record does not exist in database.');
    }

    if (existingSettlement.status === SettlementStatus.COMPLETED) {
      await this.logRejection(context, 'SETTLEMENT_ALREADY_COMPLETED', 'Settlement is already completed.');
      throw new SorobanSubmissionError('Policy Violation: Settlement has already completed on-chain.');
    }

    // 14. Stale Settlement Assertion (24 Hours)
    const maxAgeMs = 24 * 60 * 60 * 1000;
    if (Date.now() - existingSettlement.createdAt.getTime() > maxAgeMs) {
      await this.logRejection(context, 'STALE_SETTLEMENT', 'Settlement was created more than 24 hours ago.');
      throw new SorobanSubmissionError('Policy Violation: Settlement transaction request is stale (> 24 hours).');
    }

    // 15. Single Transaction Amount Bounds
    const payoutUsdc = parseFloat(order.destinationAmount.toString());
    if (payoutUsdc < config.treasury.minSettlementUsdc) {
      await this.logRejection(context, 'BELOW_MIN_SETTLEMENT', `Amount ${payoutUsdc} below minimum ${config.treasury.minSettlementUsdc}.`);
      throw new SorobanSubmissionError(`Policy Violation: Settlement amount is below configured minimum (${config.treasury.minSettlementUsdc} USDC).`);
    }

    if (payoutUsdc > config.treasury.maxSingleSettlementUsdc) {
      await this.logRejection(context, 'EXCEEDS_SINGLE_LIMIT', `Amount ${payoutUsdc} exceeds limit ${config.treasury.maxSingleSettlementUsdc}.`);
      throw new SorobanSubmissionError(`Policy Violation: Settlement amount exceeds maximum single transaction limit (${config.treasury.maxSingleSettlementUsdc} USDC).`);
    }

    // 16. Authoritative Database Cumulative Outflow Limits (Hourly & Daily)
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [hourlyOutflowRaw, dailyOutflowRaw] = await Promise.all([
      prisma.treasuryTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: 'SETTLEMENT_PAYOUT',
          createdAt: { gte: oneHourAgo },
        },
      }),
      prisma.treasuryTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: 'SETTLEMENT_PAYOUT',
          createdAt: { gte: twentyFourHoursAgo },
        },
      }),
    ]);

    const hourlyOutflow = parseFloat(hourlyOutflowRaw._sum.amount?.toString() || '0');
    const dailyOutflow = parseFloat(dailyOutflowRaw._sum.amount?.toString() || '0');

    if (hourlyOutflow + payoutUsdc > config.treasury.maxHourlyOutflowUsdc) {
      await this.logRejection(context, 'EXCEEDS_HOURLY_LIMIT', `Hourly outflow limit exceeded (${hourlyOutflow + payoutUsdc} > ${config.treasury.maxHourlyOutflowUsdc}).`);
      throw new SorobanSubmissionError(`Policy Violation: Transaction would exceed 1-hour cumulative outflow limit (${config.treasury.maxHourlyOutflowUsdc} USDC).`);
    }

    if (dailyOutflow + payoutUsdc > config.treasury.maxDailyOutflowUsdc) {
      await this.logRejection(context, 'EXCEEDS_DAILY_LIMIT', `Daily outflow limit exceeded (${dailyOutflow + payoutUsdc} > ${config.treasury.maxDailyOutflowUsdc}).`);
      throw new SorobanSubmissionError(`Policy Violation: Transaction would exceed 24-hour cumulative outflow limit (${config.treasury.maxDailyOutflowUsdc} USDC).`);
    }

    // 17. Log Successful Policy Approval
    await AuditService.log({
      actor: 'system-policy-engine',
      action: 'SETTLEMENT_POLICY_APPROVED',
      resource: 'Settlement',
      resourceId: existingSettlement.id,
      details: {
        settlementId: context.settlementId,
        orderId: context.orderId,
        destination: xdrDestinationAddress,
        amount: order.destinationAmount.toString(),
        contractAddress: targetContractAddress,
      },
    });
  }

  private async logRejection(context: { settlementId: string; orderId: string }, code: string, reason: string): Promise<void> {
    await AuditService.log({
      actor: 'system-policy-engine',
      action: 'SETTLEMENT_POLICY_REJECTED',
      resource: 'Settlement',
      resourceId: context.settlementId,
      details: {
        settlementId: context.settlementId,
        orderId: context.orderId,
        code,
        reason,
      },
    });
  }
}
