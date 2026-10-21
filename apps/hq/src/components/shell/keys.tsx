'use client'

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

/**
 * The current page's keys: a page names the keys it
 * handles, the footer shows the first four and `?` shows them all beside
 * HQ's own. A key a page doesn't list doesn't exist — there are no hidden
 * keys.
 */

export type KeyHint = readonly [key: string, label: string]

type Registry = {
  keys: readonly KeyHint[]
  set: (keys: readonly KeyHint[]) => void
}

const KeysContext = createContext<Registry>({ keys: [], set: () => {} })

export function PageKeysProvider({ children }: { children: ReactNode }) {
  const [keys, set] = useState<readonly KeyHint[]>([])
  const value = useMemo(() => ({ keys, set }), [keys])
  return <KeysContext.Provider value={value}>{children}</KeysContext.Provider>
}

/** The keys this page handles right now; cleared when the page leaves. */
export function usePageKeyHints(keys: readonly KeyHint[]): void {
  const { set } = useContext(KeysContext)
  const signature = JSON.stringify(keys)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the dependency — a new array with the same keys changes nothing
  useEffect(() => {
    set(keys)
  }, [signature, set])
  useEffect(() => () => set([]), [set])
}

export function usePageKeyList(): readonly KeyHint[] {
  return useContext(KeysContext).keys
}
