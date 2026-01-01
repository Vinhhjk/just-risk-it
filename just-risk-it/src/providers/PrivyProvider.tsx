import { PrivyProvider as PrivyProviderBase } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, WagmiProvider } from 'wagmi';
import { http } from 'viem';
import { monadTestnet } from 'wagmi/chains';

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || '';
const queryClient = new QueryClient();

// Create wagmi config - Privy will handle the connection
const wagmiConfig = createConfig({
  chains: [monadTestnet],
  transports: {
    [monadTestnet.id]: http(),
  },
  // Note: Privy handles wallet connections, so we don't need connectors here
});

interface PrivyProviderProps {
  children: React.ReactNode;
}

export function PrivyProvider({ children }: PrivyProviderProps) {
  if (!PRIVY_APP_ID) {
    console.warn('VITE_PRIVY_APP_ID is not set in environment variables');
  }

  return (
    <PrivyProviderBase
      appId={PRIVY_APP_ID}
      config={{
        // Only allow external wallets, no embedded wallets
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'off',
          },
        },
        // Configure supported login methods (wallet only for now)
        loginMethods: ['wallet'],
        // Configure supported chains
        supportedChains: [monadTestnet],
        appearance: {
          theme: 'dark',
          accentColor: '#B8A7FF',
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          {children}
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProviderBase>
  );
}

