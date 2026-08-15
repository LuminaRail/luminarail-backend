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
  raw: any;
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

      const body: any = await response.json().catch(() => null);

      if (!response.ok || !body || !body.status) {
        const errorMsg = body?.message || `Paystack initialize request failed with status ${response.status}`;
        throw new ProviderError(`Paystack Transaction Initialization Failed: ${errorMsg}`);
      }

      return {
        authorizationUrl: body.data.authorization_url,
        accessCode: body.data.access_code,
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

      const body: any = await response.json().catch(() => null);

      if (!response.ok || !body || !body.status) {
        const errorMsg = body?.message || `Paystack verify request failed with status ${response.status}`;
        throw new ProviderError(`Paystack Transaction Verification Failed: ${errorMsg}`);
      }

      const data = body.data;

      return {
        id: data.id,
        status: (data.status || '').toLowerCase(),
        reference: data.reference,
        amountInKobo: data.amount,
        currency: (data.currency || 'NGN').toUpperCase(),
        channel: data.channel,
        customerEmail: data.customer?.email,
        paidAt: data.paid_at,
        raw: data,
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
}
