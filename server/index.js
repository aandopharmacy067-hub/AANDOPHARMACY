import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import dotenv from 'dotenv'
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: process.env.SERVER_ENV_FILE || path.resolve(__dirname, '../.env.server') })

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
const serviceAccountFileExists = Boolean(serviceAccountPath && existsSync(path.resolve(serviceAccountPath)))
const managedIdentityAvailable = Boolean(process.env.K_SERVICE || process.env.GAE_ENV || process.env.GOOGLE_CLOUD_PROJECT)
const firebaseAdminCredentialsConfigured = Boolean(serviceAccountJson || serviceAccountFileExists || managedIdentityAvailable)
const credential = serviceAccountJson ? cert(JSON.parse(serviceAccountJson)) : applicationDefault()
const firebaseApp = getApps()[0] ?? initializeApp({ credential, ...(projectId ? { projectId } : {}) })
const auth = getAuth(firebaseApp)
const db = getFirestore(firebaseApp)
const app = express()
const port = Number(process.env.PORT || 3001)
const paystackSecret = process.env.PAYSTACK_SECRET_KEY
const publicOrigin = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_APP_URL || 'http://localhost:5173'
const allowedOrigin = new URL(publicOrigin).origin
const configuredOrigins = new Set([allowedOrigin, process.env.PUBLIC_APP_URL, process.env.RENDER_EXTERNAL_URL].filter(Boolean).map((origin) => new URL(origin).origin))
const mnotifyApiKey = process.env.MNOTIFY_API_KEY
const mnotifySenderId = process.env.MNOTIFY_SENDER_ID?.trim() ?? ''
const currency = 'GHS'
const frontendBuildPath = path.resolve(__dirname, '../dist')

if (!existsSync(path.join(frontendBuildPath, 'index.html'))) {
  console.error('Frontend build is missing. Run `npm run build` before starting the production server.')
  process.exit(1)
}

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use('/api', (request, response, next) => {
  const origin = request.headers.origin
  const requestOrigin = `${request.protocol}://${request.get('host')}`
  const localDevOrigins = new Set(['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'])
  if (origin && origin !== requestOrigin && !configuredOrigins.has(origin) && !(process.env.NODE_ENV !== 'production' && localDevOrigins.has(origin))) {
    return response.status(403).json({ error: 'Origin not allowed.' })
  }
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (request.method === 'OPTIONS') return response.sendStatus(204)
  next()
})

function requirePaystack(response) {
  if (!paystackSecret) {
    response.status(503).json({ error: 'Payments are not configured on this server.' })
    return false
  }
  return true
}

function requireFirebaseAdmin(response) {
  if (!projectId || !firebaseAdminCredentialsConfigured) {
    response.status(503).json({ error: 'Firebase Admin server credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or provide a valid GOOGLE_APPLICATION_CREDENTIALS file on the server.' })
    return false
  }
  return true
}

function authenticateUser(request, response, next) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')
  if (!match) return response.status(401).json({ error: 'Sign in to continue.' })
  auth.verifyIdToken(match[1], true).then((decoded) => {
    request.user = decoded
    next()
  }).catch((error) => {
    const code = error && typeof error.code === 'string' ? error.code : 'unknown'
    console.error(`Firebase ID token verification failed: ${code}`)
    if (code === 'auth/insufficient-permission') return response.status(503).json({ error: 'Firebase Admin is missing permission to verify accounts.' })
    return response.status(401).json({ error: 'Your session expired. Sign in again.' })
  })
}

function requireVerifiedEmail(request, response, next) {
  if (!request.user?.email_verified) return response.status(403).json({ error: 'Verify your email before checkout.' })
  next()
}

function localGhanaNumber(value) {
  const digits = String(value).trim().replace(/[^\d+]/g, '')
  const local = digits.startsWith('+233') ? `0${digits.slice(4)}` : digits.startsWith('233') ? `0${digits.slice(3)}` : digits
  return /^0\d{9}$/.test(local) ? local : null
}

async function sendCustomerSms(uid, eventId, message) {
  if (!mnotifyApiKey || !mnotifySenderId || mnotifySenderId.length > 11) return false
  const profile = await db.doc(`users/${uid}`).get()
  if (!profile.exists || profile.get('smsConsent') !== true) return false
  const recipient = localGhanaNumber(profile.get('phone') ?? '')
  if (!recipient) return false

  const eventRef = db.doc(`smsEvents/${eventId}`)
  const shouldSend = await db.runTransaction(async (transaction) => {
    const previous = await transaction.get(eventRef)
    if (previous.exists && ['sending', 'sent'].includes(previous.get('status'))) return false
    transaction.set(eventRef, {
      customerId: uid,
      eventType: eventId.split('_')[0],
      recipientLastFour: recipient.slice(-4),
      status: 'sending',
      attempts: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
      ...(previous.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true })
    return true
  })
  if (!shouldSend) return false

  try {
    const endpoint = new URL('https://api.mnotify.com/api/sms/quick')
    endpoint.searchParams.set('key', mnotifyApiKey)
    const smsResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: [recipient], sender: mnotifySenderId, message: message.slice(0, 500), is_schedule: false, schedule_date: '' }),
      signal: AbortSignal.timeout(10000),
    })
    const result = await smsResponse.json()
    if (!smsResponse.ok || result.status !== 'success') throw new Error(`mNotify returned HTTP ${smsResponse.status}`)
    await eventRef.update({ status: 'sent', providerCampaignId: result.summary?._id ?? null, sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return true
  } catch (error) {
    await eventRef.update({ status: 'failed', failureCode: error instanceof Error ? error.name : 'unknown', updatedAt: FieldValue.serverTimestamp() })
    throw error
  }
}

function orderDateParts(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '')
}

function priceFor(product, wholesalePricing, mode, quantity) {
  if (mode === 'retail') return Number(product.retailPricePesewas)
  if (!wholesalePricing) throw new Error('Wholesale pricing is unavailable.')
  const tiers = Array.isArray(wholesalePricing.wholesaleTiers) ? wholesalePricing.wholesaleTiers : []
  const tier = tiers.filter((entry) => quantity >= Number(entry.minQuantity)).sort((a, b) => Number(b.minQuantity) - Number(a.minQuantity))[0]
  if (tier) return Number(tier.unitPricePesewas)
  if (wholesalePricing.minimumWholesaleQuantity && quantity < Number(wholesalePricing.minimumWholesaleQuantity)) {
    throw new Error(`Minimum wholesale quantity is ${wholesalePricing.minimumWholesaleQuantity}.`)
  }
  return Number(wholesalePricing.wholesalePricePesewas)
}

async function releaseReservation(orderId, reason) {
  const orderRef = db.doc(`orders/${orderId}`)
  await db.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef)
    if (!orderSnapshot.exists || orderSnapshot.get('reservationStatus') !== 'reserved') return
    const order = orderSnapshot.data()
    const lines = order.items ?? []
    const refs = lines.map((line) => db.doc(`products/${line.productId}`))
    const snapshots = await transaction.getAll(...refs)
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) return
      transaction.update(refs[index], { reservedStock: Math.max(0, Number(snapshot.get('reservedStock') ?? 0) - Number(lines[index].quantity)), updatedAt: FieldValue.serverTimestamp() })
    })
    transaction.update(orderRef, { reservationStatus: 'released', orderStatus: reason === 'expired' ? 'payment_expired' : 'payment_failed', paymentStatus: reason === 'expired' ? 'expired' : 'failed', updatedAt: FieldValue.serverTimestamp() })
    transaction.set(db.doc(`payments/${orderId}`), { status: reason === 'expired' ? 'expired' : 'failed', failureReason: reason, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  })
}

async function verifyPaystack(reference) {
  const providerResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${paystackSecret}` },
    signal: AbortSignal.timeout(15000),
  })
  const payload = await providerResponse.json()
  if (!providerResponse.ok || payload.status !== true || payload.data?.status !== 'success' || payload.data?.reference !== reference) {
    throw new Error('Paystack has not confirmed this payment.')
  }
  return payload.data
}

async function commitVerifiedPayment(reference, verified) {
  const orderRef = db.doc(`orders/${reference}`)
  const paymentRef = db.doc(`payments/${reference}`)
  const updated = await db.runTransaction(async (transaction) => {
    const [orderSnapshot, paymentSnapshot] = await transaction.getAll(orderRef, paymentRef)
    if (!orderSnapshot.exists || !paymentSnapshot.exists) throw new Error('Order not found.')
    const order = orderSnapshot.data()
    const payment = paymentSnapshot.data()
    if (payment.status === 'success') return false
    if (Number(verified.amount) !== Number(order.totalPesewas) || verified.currency !== currency || Number(payment.amountPesewas) !== Number(order.totalPesewas)) {
      throw new Error('Verified amount or currency does not match the order.')
    }
    const lines = order.items ?? []
    const refs = lines.map((line) => db.doc(`products/${line.productId}`))
    const products = await transaction.getAll(...refs)
    if (order.reservationStatus !== 'reserved') {
      transaction.update(orderRef, { paymentStatus: 'success', orderStatus: 'refund_pending', refundReviewRequired: true, updatedAt: FieldValue.serverTimestamp() })
      transaction.update(paymentRef, { status: 'success', providerTransactionId: verified.id ?? null, verifiedAt: FieldValue.serverTimestamp(), refundReviewRequired: true })
      return true
    }
    products.forEach((snapshot, index) => {
      const line = lines[index]
      if (!snapshot.exists || Number(snapshot.get('stock') ?? 0) < Number(line.quantity) || Number(snapshot.get('reservedStock') ?? 0) < Number(line.quantity)) {
        throw new Error('Reserved inventory is inconsistent; order requires manual review.')
      }
      transaction.update(refs[index], { stock: Number(snapshot.get('stock')) - Number(line.quantity), reservedStock: Number(snapshot.get('reservedStock')) - Number(line.quantity), updatedAt: FieldValue.serverTimestamp() })
      transaction.create(db.collection('inventoryMovements').doc(), { productId: line.productId, orderId: reference, type: 'sale', quantity: -Number(line.quantity), actorId: 'paystack-server', createdAt: FieldValue.serverTimestamp() })
    })
    transaction.update(orderRef, { reservationStatus: 'committed', paymentStatus: 'success', orderStatus: 'payment_confirmed', updatedAt: FieldValue.serverTimestamp() })
    transaction.update(paymentRef, { status: 'success', providerTransactionId: verified.id ?? null, verifiedAt: FieldValue.serverTimestamp(), providerReference: reference })
    transaction.create(db.collection('notifications').doc(), { recipientId: order.customerId, type: 'payment.confirmed', resourceId: reference, read: false, createdAt: FieldValue.serverTimestamp() })
    transaction.create(db.collection('activityLogs').doc(), { actorId: 'paystack-server', type: 'payment.confirmed', resourceId: reference, createdAt: FieldValue.serverTimestamp() })
    return true
  })
  if (updated) {
    const order = await orderRef.get()
    await sendCustomerSms(String(order.get('customerId')), `payment_${reference}`, `A & O Pharmacy: payment for order ${reference} is confirmed. We will keep you updated on your order.`).catch(() => undefined)
  }
}

app.get('/api/health', (_request, response) => response.json({
  ok: true,
  paystackConfigured: Boolean(paystackSecret),
  firebaseProjectConfigured: Boolean(projectId),
  firebaseAdminCredentialsConfigured,
  smsConfigured: Boolean(mnotifyApiKey && mnotifySenderId),
}))

app.post('/api/notifications/auth-sms', express.json({ limit: '10kb' }), (request, response, next) => requireFirebaseAdmin(response) && next(), authenticateUser, async (request, response) => {
  const event = request.body?.event
  if (!['signup', 'login'].includes(event)) return response.status(400).json({ error: 'Unsupported SMS event.' })
  const uid = request.user.uid
  const eventId = event === 'signup' ? `signup_${uid}` : `login_${uid}_${Math.floor(Date.now() / (15 * 60 * 1000))}`
  const profile = await db.doc(`users/${uid}`).get()
  if (!profile.exists || profile.get('smsConsent') !== true) return response.json({ sent: false, reason: 'not_consented' })
  const firstName = String(profile.get('fullName') ?? '').trim().split(/\s+/)[0] || 'there'
  const text = event === 'signup'
    ? `Welcome to A & O Pharmacy, ${firstName}. Your account is ready. We will text you about your orders and payments.`
    : `A & O Pharmacy: successful sign-in to your account. If this was not you, please secure your account.`
  try {
    const sent = await sendCustomerSms(uid, eventId, text)
    return response.json({ sent })
  } catch {
    return response.status(502).json({ sent: false, error: 'SMS provider is temporarily unavailable.' })
  }
})

app.post('/api/payments/checkout', express.json({ limit: '100kb' }), (request, response, next) => requireFirebaseAdmin(response) && next(), authenticateUser, requireVerifiedEmail, async (request, response) => {
  if (!requirePaystack(response)) return
  const { items, mode, address, deliveryInstructions } = request.body ?? {}
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) return response.status(400).json({ error: 'Cart is empty or invalid.' })
  if (!['retail', 'wholesale'].includes(mode)) return response.status(400).json({ error: 'Invalid shopping mode.' })
  if (!address || typeof address !== 'object') return response.status(400).json({ error: 'Delivery address is required.' })
  const normalizedAddress = {}
  for (const field of ['fullName', 'phone', 'street', 'city', 'region']) {
    const value = address[field]
    if (typeof value !== 'string' || value.trim().length < 2 || value.length > 200) return response.status(400).json({ error: `Enter a valid ${field}.` })
    normalizedAddress[field] = value.trim()
  }
  const quantities = new Map()
  for (const line of items) {
    if (!line || typeof line.productId !== 'string' || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 200) return response.status(400).json({ error: 'Invalid product quantity.' })
    quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity)
  }

  const now = new Date()
  const dateKey = orderDateParts(now)
  const counterRef = db.doc(`settings/orderCounters_${dateKey}`)
  const userRef = db.doc(`users/${request.user.uid}`)
  const commerceRef = db.doc('settings/commerce')
  const ids = [...quantities.keys()]
  const productRefs = ids.map((id) => db.doc(`products/${id}`))
  const pricingRefs = mode === 'wholesale' ? ids.map((id) => db.doc(`wholesalePricing/${id}`)) : []
  const reservationUntil = Timestamp.fromMillis(now.getTime() + 30 * 60 * 1000)

  let order
  try {
    order = await db.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(userRef, commerceRef, counterRef, ...productRefs, ...pricingRefs)
      const [userSnapshot, commerceSnapshot, counterSnapshot] = snapshots
      if (!userSnapshot.exists || userSnapshot.get('accountStatus') === 'suspended') throw new Error('Customer account is unavailable.')
      const commerce = commerceSnapshot.data() ?? {}
      const wholesaleAllowed = userSnapshot.get('wholesaleStatus') === 'approved' || commerce.wholesaleAccess === 'open'
      if (mode === 'wholesale' && !wholesaleAllowed) throw new Error('Wholesale account approval is required.')
      const counter = counterSnapshot.data() ?? { sequence: 0 }
      const sequence = Number(counter.sequence ?? 0) + 1
      const orderId = `AO-${dateKey}-${String(sequence).padStart(5, '0')}`
      const productSnapshots = snapshots.slice(3, 3 + productRefs.length)
      const pricingSnapshots = snapshots.slice(3 + productRefs.length)
      const lines = []
      let subtotalPesewas = 0
      productSnapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) throw new Error('A product in your cart is no longer available.')
        const product = snapshot.data()
        const quantity = quantities.get(snapshot.id)
        if (product.publicationStatus !== 'published' || product.onlineSaleApproved !== true || product.expired === true) throw new Error(`${product.name ?? 'A product'} is unavailable for online sale.`)
        if (product.prescriptionRequired === true) throw new Error('Prescription products require pharmacist review before checkout.')
        const available = Number(product.stock ?? 0) - Number(product.reservedStock ?? 0)
        if (!Number.isSafeInteger(available) || available < quantity) throw new Error(`${product.name ?? 'A product'} has insufficient stock.`)
        const price = priceFor(product, pricingSnapshots[index]?.data(), mode, quantity)
        const lineTotalPesewas = price * quantity
        if (!Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(lineTotalPesewas)) throw new Error('Invalid product pricing.')
        subtotalPesewas += lineTotalPesewas
        lines.push({ productId: snapshot.id, name: String(product.name), sku: String(product.sku ?? ''), quantity, unitPricePesewas: price, lineTotalPesewas })
        transaction.update(productRefs[index], { reservedStock: Number(product.reservedStock ?? 0) + quantity, updatedAt: FieldValue.serverTimestamp() })
      })
      const deliveryFeePesewas = Number(commerce.deliveryFeePesewas ?? 0)
      const totalPesewas = subtotalPesewas + deliveryFeePesewas
      if (!Number.isSafeInteger(totalPesewas) || totalPesewas <= 0) throw new Error('Invalid order total.')
      transaction.set(counterRef, { sequence, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      transaction.create(db.doc(`orders/${orderId}`), {
        orderId, customerId: request.user.uid, mode, items: lines, currency,
        subtotalPesewas, deliveryFeePesewas, totalPesewas, address: normalizedAddress,
        deliveryInstructions: String(deliveryInstructions ?? '').slice(0, 500),
        orderStatus: 'pending_payment', paymentStatus: 'pending', reservationStatus: 'reserved',
        reservationExpiresAt: reservationUntil, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      })
      transaction.create(db.doc(`payments/${orderId}`), { orderId, reference: orderId, customerId: request.user.uid, amountPesewas: totalPesewas, currency, status: 'pending', createdAt: FieldValue.serverTimestamp() })
      transaction.create(db.collection('activityLogs').doc(), { actorId: request.user.uid, type: 'order.created', resourceId: orderId, createdAt: FieldValue.serverTimestamp() })
      return { orderId, totalPesewas, email: String(userSnapshot.get('email') ?? request.user.email ?? '') }
    })
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : 'Order could not be prepared.' })
  }

  await sendCustomerSms(request.user.uid, `order_${order.orderId}`, `A & O Pharmacy: order ${order.orderId} has been received. Payment is pending. We will update you when payment is confirmed.`).catch(() => undefined)

  try {
    const initResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paystackSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: order.email, amount: order.totalPesewas, currency, reference: order.orderId, callback_url: `${allowedOrigin}/?reference=${encodeURIComponent(order.orderId)}` }),
      signal: AbortSignal.timeout(15000),
    })
    const payload = await initResponse.json()
    if (!initResponse.ok || payload.status !== true || !payload.data?.authorization_url) throw new Error(payload.message ?? 'Paystack checkout could not be initialized.')
    await db.doc(`payments/${order.orderId}`).update({ accessCode: payload.data.access_code ?? null, initializedAt: FieldValue.serverTimestamp() })
    response.json({ orderId: order.orderId, authorizationUrl: payload.data.authorization_url })
  } catch (error) {
    await releaseReservation(order.orderId, 'initialization_failed').catch(() => undefined)
    response.status(502).json({ error: error instanceof Error ? error.message : 'Payment provider unavailable. Retry checkout.' })
  }
})

app.post('/api/payments/verify', express.json({ limit: '10kb' }), (request, response, next) => requireFirebaseAdmin(response) && next(), authenticateUser, requireVerifiedEmail, async (request, response) => {
  if (!requirePaystack(response)) return
  const reference = String(request.body?.reference ?? '')
  if (!/^AO-\d{8}-\d{5,}$/.test(reference)) return response.status(400).json({ error: 'Invalid order reference.' })
  const orderSnapshot = await db.doc(`orders/${reference}`).get()
  if (!orderSnapshot.exists || orderSnapshot.get('customerId') !== request.user.uid) return response.status(404).json({ error: 'Order not found.' })
  try {
    const verified = await verifyPaystack(reference)
    await commitVerifiedPayment(reference, verified)
    const updated = await orderSnapshot.ref.get()
    return response.json({ orderId: reference, paymentStatus: updated.get('paymentStatus'), orderStatus: updated.get('orderStatus') })
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : 'Payment verification failed.' })
  }
})

app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (request, response) => {
  if (!requirePaystack(response)) return
  if (!requireFirebaseAdmin(response)) return
  const signature = request.header('x-paystack-signature') ?? ''
  const expected = crypto.createHmac('sha512', paystackSecret).update(request.body).digest()
  let received
  try { received = Buffer.from(signature, 'hex') } catch { return response.sendStatus(401) }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return response.sendStatus(401)
  let event
  try { event = JSON.parse(request.body.toString('utf8')) } catch { return response.sendStatus(400) }
  const reference = event?.data?.reference
  if (!reference || typeof reference !== 'string') return response.sendStatus(200)
  try {
    if (event.event === 'charge.failed') {
      await releaseReservation(reference, 'payment_failed')
      return response.sendStatus(200)
    }
    if (event.event !== 'charge.success') return response.sendStatus(200)
    const verified = await verifyPaystack(reference)
    await commitVerifiedPayment(reference, verified)
    return response.sendStatus(200)
  } catch (error) {
    console.error('Paystack webhook processing failed:', error instanceof Error ? error.message : 'unknown error')
    return response.sendStatus(500)
  }
})

async function expirePaymentReservations() {
  try {
    const expired = await db.collection('orders')
      .where('reservationStatus', '==', 'reserved')
      .where('reservationExpiresAt', '<=', Timestamp.now())
      .limit(100)
      .get()
    await Promise.all(expired.docs.map((order) => releaseReservation(order.id, 'expired')))
  } catch (error) {
    console.error('Reservation cleanup failed:', error instanceof Error ? error.message : 'unknown error')
  }
}

if (firebaseAdminCredentialsConfigured && projectId) {
  const reservationCleanup = setInterval(() => void expirePaymentReservations(), 5 * 60 * 1000)
  reservationCleanup.unref()
}

app.use(express.static(frontendBuildPath, { index: false, maxAge: '1h' }))
app.get('*path', (request, response, next) => {
  if (request.path.startsWith('/api/')) return response.status(404).json({ error: 'API route not found.' })
  response.sendFile(path.join(frontendBuildPath, 'index.html'), (error) => error && next(error))
})

app.listen(port, '0.0.0.0', () => console.log(`A & O Pharmacy server listening on port ${port}`))
