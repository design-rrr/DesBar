import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { config } from './config.js'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]

const PUBLISH_TIMEOUT = 10000

export async function publishNote({ opinion, imageUrl, itemId }) {
  const relays = config.nostrRelays?.length
    ? config.nostrRelays
    : DEFAULT_RELAYS

  const content = [
    opinion,
    imageUrl,
    `stacker.news/items/${itemId}/r/${config.botName}`,
  ].filter(Boolean).join('\n\n')

  let privateKey
  try {
    const decoded = nip19.decode(config.nostrSec)
    privateKey = decoded.data
    if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
      throw new Error('Invalid private key')
    }
  } catch (err) {
    console.warn(`Nostr publish failed: ${err.message}`)
    return
  }

  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['r', `stacker.news/items/${itemId}/r/${config.botName}`],
    ],
    content,
  }, privateKey)

  console.log(`Nostr event ID: ${event.id}`)
  console.log(`Nostr pubkey: ${event.pubkey}`)
  console.log(`Nostr created_at: ${event.created_at} (${new Date(event.created_at * 1000).toISOString()})`)
  console.log(`Local time: ${new Date().toISOString()}`)
  console.log(`Nostr content (${content.length} chars):`)
  for (const line of content.split('\n')) {
    console.log(`  ${line}`)
  }
  console.log(`  Relays: ${relays.join(', ')}`)
  // Verify event JSON is valid
  try {
    const evJson = JSON.stringify(event)
    console.log(`  Event JSON length: ${evJson.length}`)
    JSON.parse(evJson)
  } catch (e) {
    console.warn(`  Event JSON INVALID: ${e.message}`)
  }

  const pool = new SimplePool()
  let published = false

  try {
    const relaysToTry = [...relays]
    const tryPublish = relaysToTry.map(relay =>
      new Promise(resolve => {
        const pub = pool.publish([relay], event)
        pub[0]
          .then(() => {
            console.log(`  Nostr published to ${relay}`)
            resolve(true)
          })
          .catch(err => {
            console.warn(`  Nostr failed on ${relay}: ${err?.message || err || 'unknown'}`)
            resolve(false)
          })
      })
    )
    const results = await Promise.all(tryPublish)
    published = results.some(r => r)
    if (published) {
      console.log(`Nostr note published: ${event.id}`)
      // Verify the event was actually stored
      await new Promise(r => setTimeout(r, 2000))
      const successfulRelays = relays.filter((_, i) => results[i])
      for (const relay of successfulRelays) {
        try {
          const check = await pool.querySync([relay], { ids: [event.id], limit: 1 }, { maxWait: 4000 })
          if (check.length > 0) {
            console.log(`  Verified on ${relay}`)
          } else {
            console.warn(`  NOT FOUND on ${relay} (accepted but not stored)`)
          }
        } catch (err) {
          console.warn(`  Verify query error on ${relay}: ${err.message}`)
        }
      }
    } else {
      console.warn('Nostr note failed on all relays')
    }
  } catch (err) {
    console.warn(`Nostr publish error: ${err?.message || err}`)
  } finally {
    pool.close(relays)
  }

  return published ? event.id : null
}

const TAGS = [
  'foodstr', 'drinkstr', 'beerstr', 'brewstr', 'growstr', 'winestr',
  'coffechain',
  'food', 'cooking', 'recipes', 'homemade', 'baking', 'fermentation', 'organic',
  'gardening', 'foraging',
  'drinks', 'wine', 'beer', 'coffee', 'cocktails', 'tea',
]
const LOOKBACK_HOURS = 24

export async function reactToHashtags(alreadyReacted = []) {
  const relays = config.nostrRelays?.length
    ? config.nostrRelays
    : DEFAULT_RELAYS

  let privateKey
  try {
    const decoded = nip19.decode(config.nostrSec)
    privateKey = decoded.data
    if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) return
  } catch {
    return []
  }

  const ourPubkey = getPublicKey(privateKey)
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600
  const pool = new SimplePool()
  const reacted = []
  let totalFound = 0

  try {
    const seen = new Set()
    for (const tag of TAGS) {
      let events
      try {
        events = await pool.querySync(relays, { kinds: [1], '#t': [tag], since, limit: 20 })
      } catch (err) {
        console.warn(`  #${tag}: query failed (${err.message}), skipping`)
        continue
      }
      if (events.length > 0) {
        console.log(`  #${tag}: ${events.length} event(s) found`)
      }
      totalFound += events.length

      for (const ev of events) {
        if (seen.has(ev.id)) continue
        seen.add(ev.id)
        if (ev.pubkey === ourPubkey) continue
        if (alreadyReacted.includes(ev.id)) continue

        const reaction = finalizeEvent({
          kind: 7,
          content: '+',
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['e', ev.id],
            ['p', ev.pubkey],
          ],
        }, privateKey)

        const relayResults = await Promise.all(relays.map(relay =>
          new Promise(resolve => {
            const pub = pool.publish([relay], reaction)
            pub[0]
              .then(() => resolve(true))
              .catch(() => resolve(false))
          })
        ))
        const ok = relayResults.some(r => r)
        if (ok) {
          reacted.push(ev.id)
          console.log(`  Liked ${ev.id.slice(0, 16)}... (tag: #${tag})`)
        } else {
          console.warn(`  Reaction failed for ${ev.id.slice(0, 16)}... (tag: #${tag})`)
        }
      }
    }
  } catch (err) {
    console.warn(`Hashtag query error: ${err.message}`)
  } finally {
    pool.close(relays)
  }

  if (totalFound > 0) {
    console.log(`Hashtag scan: ${totalFound} total events, ${reacted.length} new likes`)
  } else {
    console.log('Hashtag scan: no matching events found in last 24h')
  }
  return reacted
}
