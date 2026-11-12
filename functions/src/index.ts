import { createHmac, timingSafeEqual } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { defineSecret, defineString } from 'firebase-functions/params'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

const db = getFirestore()
const paystackSecret = defineSecret('PAYSTACK_SECRET_KEY')
const mnotifyApiKey = defineSecret('SMS_API_KEY')
const mnotifySenderId = defineString('MNOTIFY_SENDER_ID')
const paystackCallbackUrl = defineString('PAYSTACK_CALLBACK_URL')
const currency = 'GHS'

type CartLine = { productId: string; quantity: number }
type StoredLine = { productId: string; name: string; sku: string; quantity: number; unitPricePesewas: number; lineTotalPesewas: number }

function localGhanaNumber(value: string): string | null {
  const digits = value.trim().replace(/[^\d+]/g, '')
  const local = digits.startsWith('+233') ? `0${digits.slice(4)}` : digits.startsWith('233') ? `0${digits.slice(3)}` : digits
  return /^0\d{9}$/.test(local) ? local : null
}

async function sendCustomerSms(uid: string, eventId: string, message: string) {
  const profile = await db.doc(`users/${uid}`).get()
  if (!profile.exists || profile.get('smsConsent') !== true) return { sent: false, reason: 'not_consented' }
  const recipient = localGhanaNumber(String(profile.get('phone') ?? ''))
  if (!recipient) return { sent: false, reason: 'invalid_ghana_number' }
  const sender = mnotifySenderId.value().trim()
  if (!sender || sender.length > 11) throw new Error('MNOTIFY_SENDER_ID must be an approved sender ID of 11 characters or fewer')

  const eventRef = db.doc(`smsEvents/${eventId}`)
  const maySend = await db.runTransaction(async (transaction) => {
    const previous = await transaction.get(eventRef)
    if (previous.exists && ['sending', 'sent'].includes(String(previous.get('status')))) return false
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
  if (!maySend) return { sent: false, reason: 'already_processed' }

  try {
    const endpoint = new URL('https://api.mnotify.com/api/sms/quick')
    endpoint.searchParams.set('key', mnotifyApiKey.value())
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: [recipient], sender, message: message.slice(0, 500), is_schedule: false, schedule_date: '' }),
      signal: AbortSignal.timeout(10000),
    })
    const result = await response.json() as { status?: string; code?: string; message?: string; summary?: { _id?: string } }
    if (!response.ok || result.status !== 'success') throw new Error(`mNotify returned HTTP ${response.status}`)
    await eventRef.update({ status: 'sent', providerCampaignId: result.summary?._id ?? null, sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { sent: true }
  } catch (error) {
    await eventRef.update({ status: 'failed', failureCode: error instanceof Error ? error.name : 'unknown', updatedAt: FieldValue.serverTimestamp() })
    throw error
  }
}

export const sendAuthSms = onCall({ secrets: [mnotifyApiKey] }, async (request) => {
  assertAuth(request.auth?.uid)
  const event = request.data?.event
  if (event !== 'signup' && event !== 'login') throw new HttpsError('invalid-argument', 'Unsupported SMS event')
  const uid = request.auth.uid
  const eventId = event === 'signup'
    ? `signup_${uid}`
    : `login_${uid}_${Math.floor(Date.now() / (15 * 60 * 1000))}`
  const profile = await db.doc(`users/${uid}`).get()
  if (!profile.exists || profile.get('smsConsent') !== true) return { sent: false, reason: 'not_consented' }
  const name = String(profile.get('fullName') ?? '').trim().split(/\s+/)[0] || 'there'
  const message = event === 'signup'
    ? `Welcome to A & O Pharmacy, ${name}. Your account is ready. We will text you about your orders and payments.`
    : `A & O Pharmacy: successful sign-in to your account. If this was not you, please secure your account.`
  try {
    return await sendCustomerSms(uid, eventId, message)
  } catch {
    console.error(`mNotify ${event} message failed for customer ${uid}`)
    return { sent: false, reason: 'provider_error' }
  }
})

function assertAuth(uid: string | undefined): asserts uid is string {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required')
}

function priceFor(product: FirebaseFirestore.DocumentData, wholesalePricing: FirebaseFirestore.DocumentData | undefined, mode: string, quantity: number): number {
  if (mode === 'retail') return Number(product.retailPricePesewas)
  if (!wholesalePricing) throw new Error('Wholesale pricing is unavailable')
  const tiers = Array.isArray(wholesalePricing.wholesaleTiers) ? wholesalePricing.wholesaleTiers : []
  const eligible = tiers.filter((tier: { minQuantity: number; unitPricePesewas: number }) => quantity >= tier.minQuantity)
    .sort((a: { minQuantity: number }, b: { minQuantity: number }) => b.minQuantity - a.minQuantity)[0]
  if (eligible) return Number(eligible.unitPricePesewas)
  if (wholesalePricing.minimumWholesaleQuantity && quantity < Number(wholesalePricing.minimumWholesaleQuantity)) {
    throw new Error(`Minimum wholesale quantity is ${wholesalePricing.minimumWholesaleQuantity}`)
  }
  const fallback = Number(wholesalePricing.wholesalePricePesewas)
  if (!Number.isSafeInteger(fallback) || fallback < 1) throw new Error('Wholesale pricing is unavailable')
  return fallback
}

function orderDateParts(now: Date) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '')
  return date
}

export const createCheckout = onCall({ secrets: [paystackSecret, mnotifyApiKey] }, async (request) => {
  assertAuth(request.auth?.uid)
  if (request.auth.token.email_verified !== true) throw new HttpsError('failed-precondition', 'Verify your email before checkout')
  const uid = request.auth.uid
  const data = request.data as { items?: CartLine[]; mode?: string; address?: Record<string, unknown>; deliveryInstructions?: string }
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 50) throw new Error('Cart is empty or invalid')
  if (data.mode !== 'retail' && data.mode !== 'wholesale') throw new Error('Invalid shopping mode')
  if (!data.address || typeof data.address !== 'object') throw new Error('Delivery address is required')
  const address = Object.fromEntries(['fullName', 'phone', 'street', 'city', 'region'].map((field) => {
    const value = data.address?.[field]
    if (typeof value !== 'string' || value.trim().length < 2 || value.length > 200) throw new Error(`A valid ${field} is required`)
    return [field, value.trim()]
  }))
  const normalized = new Map<string, number>()
  for (const line of data.items) {
    if (!line || typeof line.productId !== 'string' || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 200) throw new Error('Invalid product quantity')
    normalized.set(line.productId, (normalized.get(line.productId) ?? 0) + line.quantity)
  }

  const now = new Date()
  const dateKey = orderDateParts(now)
  const counterRef = db.doc(`settings/orderCounters_${dateKey}`)
  const userRef = db.doc(`users/${uid}`)
  const commerceRef = db.doc('settings/commerce')
  const productRefs = [...normalized.keys()].map((id) => db.doc(`products/${id}`))
  const pricingRefs = data.mode === 'wholesale' ? [...normalized.keys()].map((id) => db.doc(`wholesalePricing/${id}`)) : []
  const reservationUntil = Timestamp.fromMillis(now.getTime() + 30 * 60 * 1000)

  const order = await db.runTransaction(async (transaction) => {
    const snapshots = await transaction.getAll(userRef, commerceRef, counterRef, ...productRefs, ...pricingRefs)
    const [userSnapshot, commerceSnapshot, counterSnapshot] = snapshots
    const productSnapshots = snapshots.slice(3, 3 + productRefs.length)
    const pricingSnapshots = snapshots.slice(3 + productRefs.length)
    if (!userSnapshot.exists || userSnapshot.get('accountStatus') === 'suspended') throw new Error('Customer account is unavailable')
    const commerce = commerceSnapshot.data() ?? {}
    const wholesaleApproved = userSnapshot.get('wholesaleStatus') === 'approved'
    if (data.mode === 'wholesale' && commerce.wholesaleAccess !== 'open' && !(commerce.wholesaleAccess === 'approved' && wholesaleApproved)) throw new Error('Wholesale purchasing is not configured for this account')

    const counter = counterSnapshot.data() ?? { sequence: 0 }
    const sequence = Number(counter.sequence ?? 0) + 1
    const orderId = `AO-${dateKey}-${String(sequence).padStart(5, '0')}`
    const lines: StoredLine[] = []
    let totalPesewas = 0

    productSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) throw new Error('A product in your cart is no longer available')
      const product = snapshot.data()!
      const quantity = normalized.get(snapshot.id)!
      if (product.publicationStatus !== 'published' || product.onlineSaleApproved !== true || product.expired === true) throw new Error(`${product.name ?? 'A product'} is not available for online purchase`)
      if (product.prescriptionRequired === true) throw new Error('Prescription products require pharmacist review before checkout')
      const stock = Number(product.stock ?? 0)
      const reserved = Number(product.reservedStock ?? 0)
      if (!Number.isSafeInteger(stock) || stock - reserved < quantity) throw new Error(`${product.name ?? 'A product'} does not have enough available stock`)
      const unitPricePesewas = priceFor(product, pricingSnapshots[index]?.data(), data.mode!, quantity)
      if (!Number.isSafeInteger(unitPricePesewas) || unitPricePesewas < 1) throw new Error('A product price is invalid')
      const lineTotalPesewas = unitPricePesewas * quantity
      if (!Number.isSafeInteger(lineTotalPesewas)) throw new Error('Order total is invalid')
      totalPesewas += lineTotalPesewas
      lines.push({ productId: snapshot.id, name: String(product.name), sku: String(product.sku ?? ''), quantity, unitPricePesewas, lineTotalPesewas })
      transaction.update(productRefs[index], { reservedStock: reserved + quantity, updatedAt: FieldValue.serverTimestamp() })
    })

    const deliveryFeePesewas = Number(commerce.deliveryFeePesewas ?? 0)
    totalPesewas += deliveryFeePesewas
    if (!Number.isSafeInteger(totalPesewas) || totalPesewas < 1) throw new Error('Order total is invalid')
    const orderRef = db.doc(`orders/${orderId}`)
    const paymentRef = db.doc(`payments/${orderId}`)
    transaction.set(counterRef, { sequence, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    transaction.create(orderRef, {
      orderId, customerId: uid, mode: data.mode, items: lines, currency,
      subtotalPesewas: totalPesewas - deliveryFeePesewas, deliveryFeePesewas, totalPesewas,
      address, deliveryInstructions: String(data.deliveryInstructions ?? '').slice(0, 500),
      orderStatus: 'pending_payment', paymentStatus: 'pending', reservationStatus: 'reserved',
      reservationExpiresAt: reservationUntil, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    })
    transaction.create(paymentRef, { orderId, reference: orderId, customerId: uid, amountPesewas: totalPesewas, currency, status: 'pending', createdAt: FieldValue.serverTimestamp() })
    transaction.create(db.collection('activityLogs').doc(), { actorId: uid, type: 'order.created', resourceId: orderId, createdAt: FieldValue.serverTimestamp() })
    return { orderId, totalPesewas, email: String(userSnapshot.get('email') ?? request.auth?.token.email ?? '') }
  })

  try {
    await sendCustomerSms(uid, `order_${order.orderId}`, `A & O Pharmacy: order ${order.orderId} has been received. Payment is pending. We will update you when payment is confirmed.`)
  } catch {
    console.error(`mNotify order message failed for order ${order.orderId}`)
  }

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paystackSecret.value()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: order.email, amount: order.totalPesewas, currency, reference: order.orderId, callback_url: paystackCallbackUrl.value() }),
    })
    const payload = await response.json() as { status?: boolean; message?: string; data?: { authorization_url?: string; access_code?: string } }
    if (!response.ok || !payload.status || !payload.data?.authorization_url) throw new Error(payload.message ?? 'Payment initialization failed')
    await db.doc(`payments/${order.orderId}`).update({ accessCode: payload.data.access_code ?? null, initializedAt: FieldValue.serverTimestamp() })
    return { orderId: order.orderId, authorizationUrl: payload.data.authorization_url }
  } catch (error) {
    await releaseReservation(order.orderId, 'initialization_failed')
    throw new Error(error instanceof Error ? error.message : 'Payment initialization failed')
  }
})

async function releaseReservation(orderId: string, reason: string) {
  const orderRef = db.doc(`orders/${orderId}`)
  await db.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef)
    if (!orderSnapshot.exists || orderSnapshot.get('reservationStatus') !== 'reserved') return
    const orderData = orderSnapshot.data()!
    const productRefs = (orderData.items as StoredLine[]).map((line) => db.doc(`products/${line.productId}`))
    const products = await transaction.getAll(...productRefs)
    products.forEach((product, index) => {
      if (!product.exists) return
      const quantity = (orderData.items as StoredLine[])[index].quantity
      transaction.update(productRefs[index], { reservedStock: Math.max(0, Number(product.get('reservedStock') ?? 0) - quantity), updatedAt: FieldValue.serverTimestamp() })
    })
    transaction.update(orderRef, { reservationStatus: 'released', orderStatus: reason === 'expired' ? 'payment_expired' : 'payment_failed', paymentStatus: reason === 'expired' ? 'expired' : 'failed', updatedAt: FieldValue.serverTimestamp() })
    transaction.set(db.doc(`payments/${orderId}`), { status: reason === 'expired' ? 'expired' : 'failed', failureReason: reason, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  })
}

type VerifiedTransaction = { status?: string; reference?: string; amount?: number; currency?: string; id?: number }

async function applyVerifiedPayment(reference: string, verified: VerifiedTransaction) {
  const orderRef = db.doc(`orders/${reference}`)
  const paymentRef = db.doc(`payments/${reference}`)
  await db.runTransaction(async (transaction) => {
    const [orderSnapshot, paymentSnapshot] = await transaction.getAll(orderRef, paymentRef)
    if (!orderSnapshot.exists || !paymentSnapshot.exists) throw new Error('Order not found')
    const order = orderSnapshot.data()!
    const payment = paymentSnapshot.data()!
    if (payment.status === 'success') return
    if (verified.status !== 'success' || verified.reference !== reference || Number(verified.amount) !== Number(order.totalPesewas) || verified.currency !== currency || Number(payment.amountPesewas) !== Number(order.totalPesewas)) throw new Error('Verified payment amount or currency does not match the order')

    const lines = order.items as StoredLine[]
    const productRefs = lines.map((line) => db.doc(`products/${line.productId}`))
    const productSnapshots = await transaction.getAll(...productRefs)
    if (order.reservationStatus !== 'reserved') {
      transaction.update(orderRef, { paymentStatus: 'success', orderStatus: 'refund_pending', refundReason: 'Payment arrived after inventory reservation expired', updatedAt: FieldValue.serverTimestamp() })
      transaction.update(paymentRef, { status: 'success', providerTransactionId: verified.id ?? null, verifiedAt: FieldValue.serverTimestamp(), refundReviewRequired: true })
      return
    }
    productSnapshots.forEach((product, index) => {
      if (!product.exists) throw new Error('Reserved product no longer exists')
      const line = lines[index]
      const stock = Number(product.get('stock') ?? 0)
      const reserved = Number(product.get('reservedStock') ?? 0)
      if (stock < line.quantity || reserved < line.quantity) throw new Error('Reserved inventory is inconsistent')
      transaction.update(productRefs[index], { stock: stock - line.quantity, reservedStock: reserved - line.quantity, updatedAt: FieldValue.serverTimestamp() })
      transaction.create(db.collection('inventoryMovements').doc(), { productId: line.productId, orderId: reference, type: 'sale', quantity: -line.quantity, actorId: 'paystack-verification', createdAt: FieldValue.serverTimestamp() })
    })
    transaction.update(orderRef, { reservationStatus: 'committed', paymentStatus: 'success', orderStatus: 'payment_confirmed', updatedAt: FieldValue.serverTimestamp() })
    transaction.update(paymentRef, { status: 'success', providerTransactionId: verified.id ?? null, verifiedAt: FieldValue.serverTimestamp(), providerReference: reference })
    transaction.create(db.collection('notifications').doc(), { recipientId: order.customerId, type: 'payment.confirmed', resourceId: reference, read: false, createdAt: FieldValue.serverTimestamp() })
    transaction.create(db.collection('activityLogs').doc(), { actorId: 'paystack-verification', type: 'payment.confirmed', resourceId: reference, createdAt: FieldValue.serverTimestamp() })
  })
  const updatedOrder = await orderRef.get()
  if (updatedOrder.get('paymentStatus') === 'success') {
    try {
      await sendCustomerSms(String(updatedOrder.get('customerId')), `payment_${reference}`, `A & O Pharmacy: payment for order ${reference} has been confirmed. We will keep you updated on your order.`)
    } catch {
      console.error(`mNotify payment message failed for order ${reference}`)
    }
  }
}

export const verifyPayment = onCall({ secrets: [paystackSecret, mnotifyApiKey] }, async (request) => {
  assertAuth(request.auth?.uid)
  const reference = String(request.data?.reference ?? '')
  if (!/^AO-\d{8}-\d{5,}$/.test(reference)) throw new HttpsError('invalid-argument', 'Invalid order reference')
  const orderSnapshot = await db.doc(`orders/${reference}`).get()
  if (!orderSnapshot.exists || orderSnapshot.get('customerId') !== request.auth.uid) throw new HttpsError('not-found', 'Order not found')
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${paystackSecret.value()}` } })
  const payload = await response.json() as { status?: boolean; data?: VerifiedTransaction }
  if (!response.ok || !payload.status || !payload.data) throw new HttpsError('failed-precondition', 'Payment is not confirmed by the provider')
  await applyVerifiedPayment(reference, payload.data)
  const order = await db.doc(`orders/${reference}`).get()
  return { orderId: reference, paymentStatus: order.get('paymentStatus'), orderStatus: order.get('orderStatus') }
})

export const paystackWebhook = onRequest({ secrets: [paystackSecret, mnotifyApiKey], invoker: 'public' }, async (request, response) => {
  if (request.method !== 'POST' || !request.rawBody) { response.status(405).send('Method not allowed'); return }
  const signature = request.header('x-paystack-signature') ?? ''
  const expected = createHmac('sha512', paystackSecret.value()).update(request.rawBody).digest()
  let received: Buffer
  try { received = Buffer.from(signature, 'hex') } catch { response.status(401).send('Invalid signature'); return }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) { response.status(401).send('Invalid signature'); return }
  const event = request.body as { event?: string; data?: { reference?: string } }
  const reference = event.data?.reference
  if (!reference) { response.status(200).send('Ignored'); return }
  if (event.event === 'charge.failed') {
    await releaseReservation(reference, 'payment_failed')
    response.status(200).send('Accepted')
    return
  }
  if (event.event !== 'charge.success') { response.status(200).send('Ignored'); return }

  const verification = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${paystackSecret.value()}` } })
  const verified = await verification.json() as { status?: boolean; data?: { status?: string; reference?: string; amount?: number; currency?: string; id?: number } }
  if (!verification.ok || !verified.status || verified.data?.status !== 'success' || verified.data.reference !== reference) { response.status(400).send('Payment verification failed'); return }

  await applyVerifiedPayment(reference, verified.data!)
  response.status(200).send('Accepted')
})

export const expireReservations = onSchedule('every 15 minutes', async () => {
  const expired = await db.collection('orders').where('reservationStatus', '==', 'reserved').where('reservationExpiresAt', '<=', Timestamp.now()).limit(100).get()
  await Promise.all(expired.docs.map((snapshot) => releaseReservation(snapshot.id, 'expired')))
})
