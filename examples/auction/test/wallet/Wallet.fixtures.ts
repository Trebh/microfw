import type { Model } from "../../src/wallet/Wallet.ts"
import { Amount } from "../../src/domain/Values.ts"

export const held = (reserved: number): Model => ({ credit: 100, reserved })

export const reserved = (amount: number) => ({ _tag: "Reserved", amount: Amount.make(amount) }) as const
export const refused = (amount: number) => ({ _tag: "Refused", amount: Amount.make(amount) }) as const
export const released = { _tag: "Released" } as const
