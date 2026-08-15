import { IPaymentProvider } from './paymentProvider.interface.js';
import { MockPaymentProvider } from './mock.provider.js';
import { NgnPaymentProvider } from './ngn.provider.js';
import { PaystackNgnPaymentProvider } from './paystack.provider.js';
import { config } from '../../config/index.js';
import { NotFoundError } from '../../errors/index.js';

export class PaymentProviderRegistry {
  private static providers: Map<string, IPaymentProvider> = new Map();

  public static register(provider: IPaymentProvider): void {
    this.providers.set(provider.providerId.toUpperCase(), provider);
  }

  public static get(providerId: string): IPaymentProvider {
    const normId = (providerId || 'MOCK').toUpperCase();

    // Alias mapping for default NGN payment requests
    if (normId === 'NGN' || normId === 'NGN_BANK_TRANSFER') {
      const activeNgnMode = config.ngnProvider || 'sandbox';
      if (activeNgnMode === 'paystack') {
        const paystackProv = this.providers.get('PAYSTACK_NGN_BANK_TRANSFER');
        if (paystackProv) return paystackProv;
      }
      const sandboxProv = this.providers.get('NGN_BANK_TRANSFER');
      if (sandboxProv) return sandboxProv;
    }

    if (normId === 'PAYSTACK') {
      const paystackProv = this.providers.get('PAYSTACK_NGN_BANK_TRANSFER');
      if (paystackProv) return paystackProv;
    }

    if (normId === 'SANDBOX') {
      const sandboxProv = this.providers.get('NGN_BANK_TRANSFER');
      if (sandboxProv) return sandboxProv;
    }

    const provider = this.providers.get(normId);
    if (!provider) {
      throw new NotFoundError(`Payment provider '${providerId}' is not registered or supported.`);
    }
    return provider;
  }

  public static listProviders(): IPaymentProvider[] {
    return Array.from(this.providers.values());
  }

  public static clear(): void {
    this.providers.clear();
  }
}

// Auto-register Providers
const mockProvider = new MockPaymentProvider();
const ngnSandboxProvider = new NgnPaymentProvider();
const paystackProvider = new PaystackNgnPaymentProvider();

PaymentProviderRegistry.register(mockProvider);
PaymentProviderRegistry.register(ngnSandboxProvider);
PaymentProviderRegistry.register(paystackProvider);

