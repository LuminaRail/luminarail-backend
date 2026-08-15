import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanSettlementExecutor } from '../../src/stellar/soroban/settlement.executor.js';
import { SorobanTransactionService, parseSettlementIdToU64, parseAmountToStroops } from '../../src/stellar/soroban/transaction.service.js';
import { SorobanConfirmationService } from '../../src/stellar/soroban/confirmation.service.js';
import { config } from '../../src/config/index.js';
import { StellarNetworkError } from '../../src/errors/index.js';

describe('SorobanSettlementExecutor & Soroban Services', () => {
  const originalNetwork = config.stellar.network;
  const originalVaultContractId = config.stellar.settlementVaultContractId;
  const originalSignerSecret = config.stellar.signerSecretKey;
  const originalSignerPublic = config.stellar.signerPublicKey;

  beforeEach(() => {
    config.stellar.network = 'testnet';
    config.stellar.settlementVaultContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const kp = Keypair.random();
    config.stellar.signerSecretKey = kp.secret();
    config.stellar.signerPublicKey = kp.publicKey();
  });

  afterEach(() => {
    config.stellar.network = originalNetwork;
    config.stellar.settlementVaultContractId = originalVaultContractId;
    config.stellar.signerSecretKey = originalSignerSecret;
    config.stellar.signerPublicKey = originalSignerPublic;
    vi.restoreAllMocks();
  });

  describe('Utility & Formatting Helpers', () => {
    it('should parse settlement string ID into valid deterministic u64 BigInt', () => {
      const u64_1 = parseSettlementIdToU64('STL_1723238112_abc123');
      const u64_2 = parseSettlementIdToU64('STL_1723238112_abc123');
      expect(typeof u64_1).toBe('bigint');
      expect(u64_1).toBe(u64_2);
      expect(u64_1).toBeGreaterThan(0n);
    });

    it('should parse string decimal amounts into precise stroops BigInt', () => {
      expect(parseAmountToStroops('10.5')).toBe(105000000n);
      expect(parseAmountToStroops('0.0000001')).toBe(1n);
      expect(parseAmountToStroops('100')).toBe(1000000000n);
    });
  });

  describe('Testnet Network Safety Guard', () => {
    it('should refuse live submission if STELLAR_NETWORK is not testnet', async () => {
      config.stellar.network = 'mainnet';
      const executor = new SorobanSettlementExecutor();

      const result = await executor.submitSettlement({
        settlementId: 'STL_TEST_1',
        orderId: 'ORD_TEST_1',
        source: Keypair.random().publicKey(),
        destination: Keypair.random().publicKey(),
        amount: '10.0',
        asset: 'USDC',
      });

      expect(result.submitted).toBe(false);
      expect(result.error).toContain('Live settlement submission refused');
    });

    it('should fail closed when STELLAR_NETWORK is public', async () => {
      config.stellar.network = 'public';
      const txService = new SorobanTransactionService();

      await expect(
        txService.buildAndSubmitSettlementTransaction({
          settlementId: 'STL_TEST_2',
          orderId: 'ORD_TEST_2',
          source: Keypair.random().publicKey(),
          destination: Keypair.random().publicKey(),
          amount: '5.0',
          asset: 'USDC',
        })
      ).rejects.toThrow(StellarNetworkError);
    });
  });

  describe('Configuration Validation', () => {
    it('should fail cleanly when contract ID configuration is missing', async () => {
      config.stellar.settlementVaultContractId = '';
      const executor = new SorobanSettlementExecutor();

      const result = await executor.submitSettlement({
        settlementId: 'STL_TEST_3',
        orderId: 'ORD_TEST_3',
        source: Keypair.random().publicKey(),
        destination: Keypair.random().publicKey(),
        amount: '1.0',
        asset: 'USDC',
      });

      expect(result.submitted).toBe(false);
      expect(result.error).toContain('Contract ID is not configured');
    });

    it('should fail cleanly when secret key configuration is missing', async () => {
      config.stellar.signerSecretKey = undefined;
      const executor = new SorobanSettlementExecutor();

      const result = await executor.submitSettlement({
        settlementId: 'STL_TEST_4',
        orderId: 'ORD_TEST_4',
        source: Keypair.random().publicKey(),
        destination: Keypair.random().publicKey(),
        amount: '1.0',
        asset: 'USDC',
      });

      expect(result.submitted).toBe(false);
      expect(result.error).toContain('STELLAR_SETTLEMENT_SIGNER_SECRET_KEY is not configured');
    });
  });

  describe('Transaction Simulation & Submission Mocking', () => {
    it('should handle simulation failure without submitting on-chain', async () => {
      const mockTxService = new SorobanTransactionService();
      vi.spyOn(mockTxService, 'buildAndSubmitSettlementTransaction').mockRejectedValue(
        new Error('Soroban transaction simulation error: Host error during execution')
      );

      const executor = new SorobanSettlementExecutor(mockTxService);
      const result = await executor.submitSettlement({
        settlementId: 'STL_SIM_FAIL',
        orderId: 'ORD_SIM_FAIL',
        source: Keypair.random().publicKey(),
        destination: Keypair.random().publicKey(),
        amount: '100.0',
        asset: 'USDC',
      });

      expect(result.submitted).toBe(false);
      expect(result.error).toContain('simulation error');
    });

    it('should handle successful transaction submission', async () => {
      const mockTxService = new SorobanTransactionService();
      vi.spyOn(mockTxService, 'buildAndSubmitSettlementTransaction').mockResolvedValue({
        transactionHash: 'a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef',
      });

      const executor = new SorobanSettlementExecutor(mockTxService);
      const result = await executor.submitSettlement({
        settlementId: 'STL_SUBMIT_OK',
        orderId: 'ORD_SUBMIT_OK',
        source: Keypair.random().publicKey(),
        destination: Keypair.random().publicKey(),
        amount: '50.0',
        asset: 'USDC',
      });

      expect(result.submitted).toBe(true);
      expect(result.transactionHash).toBe('a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef');
    });
  });

  describe('Confirmation Service Mocking', () => {
    it('should report confirmed success when Soroban RPC returns SUCCESS', async () => {
      const mockConfirmService = new SorobanConfirmationService();
      vi.spyOn(mockConfirmService, 'getTransactionStatus').mockResolvedValue({
        status: 'SUCCESS',
        ledger: 998877,
      });

      const executor = new SorobanSettlementExecutor(undefined, mockConfirmService);
      const confirmation = await executor.confirmSettlement('HASH_123');

      expect(confirmation.confirmed).toBe(true);
      expect(confirmation.ledger).toBe(998877);
    });

    it('should report confirmation failure when RPC returns FAILED', async () => {
      const mockConfirmService = new SorobanConfirmationService();
      vi.spyOn(mockConfirmService, 'getTransactionStatus').mockResolvedValue({
        status: 'FAILED',
        error: 'On-chain execution failed',
      });

      const executor = new SorobanSettlementExecutor(undefined, mockConfirmService);
      const confirmation = await executor.confirmSettlement('HASH_FAILED');

      expect(confirmation.confirmed).toBe(false);
      expect(confirmation.error).toBeDefined();
    });

    it('should report timeout when transaction status remains NOT_FOUND', async () => {
      const mockConfirmService = new SorobanConfirmationService();
      vi.spyOn(mockConfirmService, 'getTransactionStatus').mockResolvedValue({
        status: 'NOT_FOUND',
      });

      const executor = new SorobanSettlementExecutor(undefined, mockConfirmService);
      const confirmation = await executor.confirmSettlement('HASH_TIMEOUT', { maxAttempts: 2, intervalMs: 1 });

      expect(confirmation.confirmed).toBe(false);
      expect(confirmation.error).toContain('timed out');
    });
  });

  describe('Secret Key Protection', () => {
    it('should never expose secret key in submission errors or logs', async () => {
      const secret = config.stellar.signerSecretKey;
      expect(secret).toBeDefined();

      config.stellar.settlementVaultContractId = '';
      const executor = new SorobanSettlementExecutor();

      const result = await executor.submitSettlement({
        settlementId: 'STL_SECRET_TEST',
        orderId: 'ORD_SECRET_TEST',
        source: Keypair.random().publicKey(),
        destination: Keypair.random().publicKey(),
        amount: '1.0',
        asset: 'USDC',
      });

      expect(result.submitted).toBe(false);
      expect(result.error).not.toContain(secret);
    });
  });
});
