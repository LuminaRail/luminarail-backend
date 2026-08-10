import { IPaymentProvider } from './paymentProvider.interface.js';
import { MockPaymentProvider } from './mock.provider.js';
import { NotFoundError } from '../../errors/index.js';

export class PaymentProviderRegistry {
  private static providers: Map<string, IPaymentProvider> = new Map();

  public static register(provider: IPaymentProvider): void {
    this.providers.set(provider.providerId.toUpperCase(), provider);
  }

  public static get(providerId: string): IPaymentProvider {
    const normId = (providerId || 'MOCK').toUpperCase();
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

// Auto-register default MockPaymentProvider
PaymentProviderRegistry.register(new MockPaymentProvider());
