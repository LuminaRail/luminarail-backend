import { config } from '../config/index.js';
import { BadRequestError, ProviderError } from '../errors/index.js';

export interface PaystackInitInput {
  amountInKobo: number;
  email: string;
  reference: string;
  currency?: string;
  callbackUrl?: string;
}

export interface PaystackInitResult extends Record<string, unknown> {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackVerifyResult {
  id: number;
  status: string; // 'success' | 'failed' | 'abandoned' | 'pending'
  reference: string;
  amountInKobo: number;
  currency: string;
  channel?: string;
  customerEmail?: string;
  paidAt?: string;
  raw: Record<string, unknown>;
}

interface PaystackInitData {
  authorization_url?: string;
  access_code?: string;
  reference?: string;
}

interface PaystackVerifyData {
  id?: number;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  channel?: string;
  customer?: { email?: string };
  paid_at?: string;
  [key: string]: unknown;
}

export class PaystackClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(secretKey?: string, baseUrl?: string) {
    this.secretKey = secretKey || config.paystack.secretKey || '';
    this.baseUrl = (baseUrl || config.paystack.baseUrl || 'https://api.paystack.co').replace(/\/$/, '');
  }

  public async initializeTransaction(input: PaystackInitInput): Promise<PaystackInitResult> {
    if (!this.secretKey) {
      throw new BadRequestError('Paystack API secret key is missing. Set PAYSTACK_SECRET_KEY in environment.');
    }

    const payload = {
      amount: Math.round(input.amountInKobo),
      email: input.email || 'customer@luminarail.com',
      reference: input.reference,
      currency: input.currency || 'NGN',
      channels: ['bank_transfer', 'card'],
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    };

    try {
      const response = await fetch(`${this.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const body = (await response.json().catch(() => null)) as { status?: boolean; message?: string; data?: PaystackInitData } | null;

      if (!response.ok || !body || !body.status || !body.data) {
        const errorMsg = body?.message || `Paystack initialize request failed with status ${response.status}`;
        throw new ProviderError(`Paystack Transaction Initialization Failed: ${errorMsg}`);
      }

      return {
        authorizationUrl: body.data.authorization_url || '',
        accessCode: body.data.access_code || '',
        reference: body.data.reference || input.reference,
      };
    } catch (err) {
      if (err instanceof ProviderError || err instanceof BadRequestError) {
        throw err;
      }
      throw new ProviderError(
        `Paystack Network Error: ${err instanceof Error ? err.message : 'Unknown communication error'}`
      );
    }
  }

  public async verifyTransaction(reference: string): Promise<PaystackVerifyResult> {
    if (!this.secretKey) {
      throw new BadRequestError('Paystack API secret key is missing. Set PAYSTACK_SECRET_KEY in environment.');
    }

    try {
      const response = await fetch(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
      });

      const body = (await response.json().catch(() => null)) as { status?: boolean; message?: string; data?: PaystackVerifyData } | null;

      if (!response.ok || !body || !body.status || !body.data) {
        const errorMsg = body?.message || `Paystack verify request failed with status ${response.status}`;
        throw new ProviderError(`Paystack Transaction Verification Failed: ${errorMsg}`);
      }

      const data = body.data;

      return {
        id: data.id || 0,
        status: (data.status || '').toLowerCase(),
        reference: data.reference || reference,
        amountInKobo: data.amount || 0,
        currency: (data.currency || 'NGN').toUpperCase(),
        channel: data.channel,
        customerEmail: data.customer?.email,
        paidAt: data.paid_at,
        raw: data as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof ProviderError || err instanceof BadRequestError) {
        throw err;
      }
      throw new ProviderError(
        `Paystack Network Error: ${err instanceof Error ? err.message : 'Unknown communication error'}`
      );
    }
  }

  public async refundTransaction(input: PaystackRefundInput): Promise<PaystackRefundResult> {
    if (!this.secretKey) {
      throw new BadRequestError('Paystack API secret key is missing. Set PAYSTACK_SECRET_KEY in environment.');
    }

    const payload: Record<string, unknown> = {
      transaction: input.transaction,
      ...(input.amountInKobo !== undefined ? { amount: Math.round(input.amountInKobo) } : {}),
      ...(input.merchantNote ? { merchant_note: input.merchantNote } : {}),
    };

    try {
      const response = await fetch(`${this.baseUrl}/refund`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const body = (await response.json().catch(() => null)) as {
        status?: boolean;
        message?: string;
        data?: {
          id?: number | string;
          status?: string;
          refund_status?: string;
          transaction?: { reference?: string };
          amount?: number;
          [key: string]: unknown;
        };
      } | null;

      if (!response.ok || !body) {
        const errorMsg = body?.message || `Paystack refund request failed with status ${response.status}`;
        if (response.status >= 400 && response.status < 500) {
          throw new ProviderError(`Paystack Refund Rejected: ${errorMsg}`);
        }
        throw new ProviderError(`Paystack Refund Request Failed: ${errorMsg}`);
      }

      const data = body.data || {};
      const statusStr = (
        data.status ||
        data.refund_status ||
        (body.status ? 'processed' : 'failed')
      )
        .toString()
        .toLowerCase();

      return {
        id: data.id || `ref_${Date.now()}`,
        status: statusStr,
        transactionReference: data.transaction?.reference || input.transaction,
        amountInKobo: data.amount || input.amountInKobo || 0,
        raw: (data || body) as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof ProviderError || err instanceof BadRequestError) {
        throw err;
      }
      throw new ProviderError(
        `Paystack Refund Network Error: ${err instanceof Error ? err.message : 'Unknown network failure'}`
      );
    }
  }
}

export interface PaystackRefundInput {
  transaction: string;
  amountInKobo?: number;
  merchantNote?: string;
}

export interface PaystackRefundResult {
  id: number | string;
  status: string;
  transactionReference: string;
  amountInKobo: number;
  raw: Record<string, unknown>;
}
