import { Method } from 'mppx'

import * as Types from './Types.js'

/**
 * NEAR Intents charge method — shared schema used by both server and client.
 *
 * The challenge `request` carries the origin-chain leg the client must pay
 * (`recipient` is a unique single-use 1Click deposit address) plus the
 * merchant's destination leg in `methodDetails`. The credential payload is
 * the client's confirmed origin-chain deposit transaction hash (push mode).
 *
 * Spec: docs/spec/draft-nearintents-charge-01.md
 */
export const charge = Method.from({
  name: Types.paymentMethod,
  intent: Types.chargeIntent,
  schema: {
    credential: {
      payload: Types.HashPayloadSchema,
    },
    request: Types.ChargeRequestSchema,
  },
})
