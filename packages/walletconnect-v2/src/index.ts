import type WalletConnectProvider from '@walletconnect/ethereum-provider'
import type { Actions, ProviderRpcError } from '@web3-react/types'
import { Connector } from '@web3-react/types'
import EventEmitter3 from 'eventemitter3'

import { ArrayOneOrMore, getBestUrlMap, getChainsWithDefault, isArrayOneOrMore } from './utils'

export const URI_AVAILABLE = 'URI_AVAILABLE'
const DEFAULT_TIMEOUT = 5000

/**
 * Options to configure the WalletConnect provider.
 * For the full list of options, see {@link https://docs.walletconnect.com/2.0/javascript/providers/ethereum#initialization WalletConnect documentation}.
 */
export type WalletConnectOptions = Omit<Parameters<typeof WalletConnectProvider.init>[0], 'rpcMap'> & {
  /**
   * Map of chainIds to rpc url(s). If multiple urls are provided, the first one that responds
   * within a given timeout will be used. Note that multiple urls are not supported by WalletConnect by default.
   * That's why we extend its options with our own `rpcMap` (@see getBestUrlMap).
   */
  rpcMap?: { [chainId: number]: string | string[] }
  /** @deprecated Use `rpcMap` instead. */
  rpc?: { [chainId: number]: string | string[] }
}

/**
 * Necessary type to interface with @walletconnect/ethereum-provider@2.9.2 which is currently unexported
 */
type ChainsProps =
  | {
      chains: ArrayOneOrMore<number>
      optionalChains?: number[]
    }
  | {
      chains?: number[]
      optionalChains: ArrayOneOrMore<number>
    }

/**
 * Options to configure the WalletConnect connector.
 */
export interface WalletConnectConstructorArgs {
  actions: Actions
  /** Options to pass to `@walletconnect/ethereum-provider`. */
  options: WalletConnectOptions
  /** The chainId to connect to in activate if one is not provided. */
  defaultChainId?: number
  /**
   * @param timeout - Timeout, in milliseconds, after which to treat network calls to urls as failed when selecting
   * online urls.
   */
  timeout?: number
  /**
   * @param onError - Handler to report errors thrown from WalletConnect.
   */
  onError?: (error: Error) => void
}

export class WalletConnect extends Connector {
  /** {@inheritdoc Connector.provider} */
  public provider?: WalletConnectProvider
  public readonly events = new EventEmitter3()

  private readonly defaultChainId?: number
  private eagerConnection?: Promise<WalletConnectProvider>
  private readonly options: Omit<WalletConnectOptions, 'rpcMap'>
  private readonly rpcMap?: Record<number, string | string[]>
  private readonly timeout: number

  constructor({ actions, defaultChainId, options, timeout = DEFAULT_TIMEOUT, onError }: WalletConnectConstructorArgs) {
    super(actions, onError)

    const { rpcMap, rpc, ...rest } = options
    this.defaultChainId = defaultChainId
    this.options = rest
    this.rpcMap = rpcMap || rpc
    this.timeout = timeout
  }

  private handleProviderEvents(provider: WalletConnectProvider): void {
    provider
      .on('disconnect', this.disconnectListener)
      .on('chainChanged', this.chainChangedListener)
      .on('accountsChanged', this.accountsChangedListener)
      .on('display_uri', this.URIListener)
  }

  private disconnectListener = (error: ProviderRpcError) => {
    this.actions.resetState()
    if (error) this.onError?.(error)
  }

  private chainChangedListener = (chainId: string): void => {
    this.actions.update({ chainId: Number.parseInt(chainId, 16) })
  }

  private accountsChangedListener = (accounts: string[]): void => {
    this.actions.update({ accounts })
  }

  private URIListener = (uri: string): void => {
    this.events.emit(URI_AVAILABLE, uri)
  }

  private async initializeProvider(
    desiredChainId: number | undefined = this.defaultChainId
  ): Promise<WalletConnectProvider> {
    const ethProviderModule = await import('@walletconnect/ethereum-provider')
    const rpcMap = this.rpcMap ? await getBestUrlMap(this.rpcMap, this.timeout) : undefined

    const provider = await ethProviderModule.default.init({
      ...this.options,
      ...this.getChainProps(desiredChainId),
      rpcMap,
    })

    this.handleProviderEvents(provider)

    return provider
  }

  // Helper function to reorder chains array based on desiredChainId
  private reorderChainsBasedOnId(
    chains: number[] | undefined,
    desiredChainId: number | undefined
  ): number[] | undefined {
    if (!chains || !desiredChainId || !chains.includes(desiredChainId) || chains.length === 0) {
      return chains
    }
    return getChainsWithDefault(chains, desiredChainId)
  }

  private getChainProps(desiredChainId: number | undefined = this.defaultChainId): ChainsProps {
    // Reorder chains and optionalChains if necessary
    const orderedChains = this.reorderChainsBasedOnId(this.options.chains, desiredChainId)
    const orderedOptionalChains = this.reorderChainsBasedOnId(this.options.optionalChains, desiredChainId)

    // Validate and return the result
    if (isArrayOneOrMore(orderedChains)) {
      return { chains: orderedChains, optionalChains: orderedOptionalChains }
    } else if (isArrayOneOrMore(orderedOptionalChains)) {
      return { optionalChains: orderedOptionalChains, chains: orderedChains }
    }

    throw new Error('Either chains or optionalChains must have at least one item.')
  }

  private isomorphicInitialize(
    desiredChainId: number | undefined = this.defaultChainId
  ): Promise<WalletConnectProvider> {
    if (this.eagerConnection) return this.eagerConnection
    this.eagerConnection = this.initializeProvider(desiredChainId)
    return this.eagerConnection
  }

  /** {@inheritdoc Connector.connectEagerly} */
  public async connectEagerly(): Promise<void> {
    const cancelActivation = this.actions.startActivation()

    try {
      const provider = await this.isomorphicInitialize()
      // WalletConnect automatically persists and restores active sessions
      if (!provider.session) {
        throw new Error('No active session found. Connect your wallet first.')
      }
      this.actions.update({ accounts: provider.accounts, chainId: provider.chainId })
    } catch (error) {
      await this.deactivate()
      cancelActivation()
      throw error
    }
  }

  public async activate(desiredChainId?: number): Promise<void> {
    const provider = await this.isomorphicInitialize(desiredChainId)

    if (provider.session) {
      console.log(provider.session.namespaces)
      if (!desiredChainId || desiredChainId === provider.chainId) return
      // WalletConnect exposes connected accounts, not chains: `eip155:${chainId}:${address}`
      const isConnectedToDesiredChain = provider.session.namespaces.eip155.accounts.some((account) =>
        account.startsWith(`eip155:${desiredChainId}:`)
      )
      if (!isConnectedToDesiredChain) {
        if (this.options.optionalChains?.includes(desiredChainId)) {
          throw new Error(
            `Cannot activate an optional chain (${desiredChainId}), as the wallet is not connected to it.\n\tYou should handle this error in application code, as there is no guarantee that a wallet is connected to a chain configured in "optionalChains".`
          )
        }
        throw new Error(
          `Unknown chain (${desiredChainId}). Make sure to include any chains you might connect to in the "chains" or "optionalChains" parameters when initializing WalletConnect.`
        )
      }
      return provider.request<void>({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${desiredChainId.toString(16)}` }],
      })
    }

    const cancelActivation = this.actions.startActivation()

    try {
      await provider.enable()
      this.actions.update({ chainId: provider.chainId, accounts: provider.accounts })
    } catch (error) {
      await this.deactivate()
      cancelActivation()
      throw error
    }
  }

  /** {@inheritdoc Connector.deactivate} */
  public async deactivate(): Promise<void> {
    this.provider
      ?.removeListener('disconnect', this.disconnectListener)
      .removeListener('chainChanged', this.chainChangedListener)
      .removeListener('accountsChanged', this.accountsChangedListener)
      .removeListener('display_uri', this.URIListener)
      .disconnect()
    this.provider = undefined
    this.eagerConnection = undefined
    this.actions.resetState()
  }
}
