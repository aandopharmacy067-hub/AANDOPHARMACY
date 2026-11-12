import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowRight, BadgeCheck, CircleCheck, ClipboardList, Heart, LogOut, Mail, Menu, Search, ShieldCheck, ShoppingBag, Trash2, Truck, X } from 'lucide-react'
import { createUserWithEmailAndPassword, onAuthStateChanged, reload, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from 'firebase/firestore'
import { auth, db, firebaseConfigured } from './lib/firebase'
import AdminPortal from './AdminPortal'
import './auth.css'
import './sms.css'
import './pharmacy.css'
import './account-status.css'
import './orders.css'

type Product = { id: string; name: string; category: string; brand: string; price: number; bulkPrice: number; stock: number; image: string; description: string }
type OrderLine = { name: string; quantity: number; lineTotalPesewas: number }
type CustomerOrder = {
  id: string
  orderId: string
  items: OrderLine[]
  totalPesewas: number
  paymentStatus: string
  orderStatus: string
  createdAt?: { toDate?: () => Date }
  updatedAt?: { toDate?: () => Date }
}
type PaymentConfirmation = Pick<CustomerOrder, 'orderId' | 'items' | 'totalPesewas' | 'orderStatus'>

const cartStorageKey = (userId: string | null) => `ao-pharmacy-cart:${userId ?? 'guest'}`
function readCart(userId: string | null): Record<string, number> {
  try {
    const stored = localStorage.getItem(cartStorageKey(userId))
    if (!stored) return {}
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] =>
      Number.isSafeInteger(entry[1]) && Number(entry[1]) > 0 && Number(entry[1]) <= 200))
  } catch {
    return {}
  }
}

const statusLabel = (status: string) => status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const orderDateLabel = (timestamp?: { toDate?: () => Date }) => timestamp?.toDate ? timestamp.toDate().toLocaleString() : 'Recently placed'

const products: Product[] = [
  { id: 'ao-001', name: 'Daily Essentials Multivitamin', category: 'Vitamins & Supplements', brand: 'Aptiva', price: 78, bulkPrice: 62, stock: 24, image: 'photo-1571781926291-c477ebfd024b', description: 'A daily multivitamin supplement. See the product packaging for ingredients and directions.' },
  { id: 'ao-002', name: 'Gentle Hydrating Lotion', category: 'Personal Care', brand: 'DermaCare', price: 54, bulkPrice: 42, stock: 18, image: 'photo-1608248543803-ba4f8c70ae0b', description: 'A gentle moisturising lotion for everyday personal care.' },
  { id: 'ao-003', name: 'Digital Thermometer', category: 'Medical Equipment', brand: 'MedSure', price: 96, bulkPrice: 79, stock: 8, image: 'photo-1584308666744-24d5c474f2ae', description: 'Digital temperature measurement device. Follow manufacturer instructions.' },
  { id: 'ao-004', name: 'First Aid Essentials Kit', category: 'First Aid', brand: 'CareWell', price: 128, bulkPrice: 102, stock: 0, image: 'photo-1603398938378-e54eab446dde', description: 'A compact selection of first aid supplies for home and travel.' },
  { id: 'ao-005', name: 'Nourishing Baby Wash', category: 'Baby & Mother Care', brand: 'Little Day', price: 68, bulkPrice: 53, stock: 31, image: 'photo-1601758228041-f3b2795255f1', description: 'A mild wash for baby care. Review the label for ingredients and use information.' },
  { id: 'ao-006', name: 'Daily Wellness Capsules', category: 'Health & Wellness', brand: 'Aptiva', price: 112, bulkPrice: 88, stock: 15, image: 'photo-1550572017-edd951b55104', description: 'A wellness supplement. Product details require pharmacy review before publication.' },
]

const categories = ['Prescription Medicines', 'Over-the-Counter Medicines', 'Vitamins & Supplements', 'Personal Care', 'Baby & Mother Care', 'First Aid', 'Medical Equipment', 'Health & Wellness']
const money = (value: number) => `GH₵ ${value.toFixed(2)}`
const productImage = (image: string) => image.startsWith('http') || image.startsWith('data:') ? image : `https://images.unsplash.com/${image}?auto=format&fit=crop&w=700&q=80`
const ADMIN_EMAIL = 'aandopharmacy067@gmail.com'
const isDesignatedAdmin = (user: User | null) => user?.email?.trim().toLowerCase() === ADMIN_EMAIL && user.emailVerified

function emailVerificationError(error: unknown) {
  const candidate = error instanceof Error && 'code' in error ? String(error.code) : ''
  const code = /^auth\/[a-z-]+$/.test(candidate) ? candidate : ''
  const explanations: Record<string, string> = {
    'auth/unauthorized-continue-uri': 'Firebase rejected the verification return URL. Add this site to Authentication > Settings > Authorized domains.',
    'auth/invalid-continue-uri': 'Firebase rejected the verification return URL. Check the app URL and Authentication > Settings > Authorized domains.',
    'auth/unauthorized-domain': 'Firebase does not authorize this site. Add its domain to Authentication > Settings > Authorized domains.',
    'auth/operation-not-allowed': 'Email/password sign-in is disabled in Firebase Authentication.',
    'auth/invalid-api-key': 'The Firebase Web API key is invalid or belongs to a different project.',
    'auth/too-many-requests': 'Firebase has temporarily limited email requests. Wait and try again.',
    'auth/network-request-failed': 'Could not reach Firebase. Check the connection and try again.',
  }
  const message = explanations[code] ?? 'Could not send the verification email. Check Firebase Authentication settings and try again.'
  return code ? `${message} (${code})` : message
}

async function requestAuthSms(user: User, event: 'signup' | 'login'): Promise<{ sent: boolean; reason?: string }> {
  const token = await user.getIdToken(true)
  const response = await fetch('/api/notifications/auth-sms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
  })
  const result = await response.json() as { sent?: boolean; reason?: string; error?: string }
  if (!response.ok) throw new Error(result.error ?? 'SMS provider is temporarily unavailable.')
  return { sent: result.sent === true, reason: result.reason }
}

function App() {
  const [view, setView] = useState<'home' | 'shop' | 'wholesale' | 'orders' | 'admin'>(() => {
    const path = window.location.pathname
    return path === '/admin' ? 'admin' : path === '/wholesale' ? 'wholesale' : path === '/shop' ? 'shop' : path === '/orders' ? 'orders' : 'home'
  })
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All products')
  const [authReady, setAuthReady] = useState(!auth)
  const [cart, setCart] = useState<Record<string, number>>(() => auth ? {} : readCart(null))
  const [cartOwnerId, setCartOwnerId] = useState<string | null>(null)
  const [mode, setMode] = useState<'retail' | 'wholesale'>('retail')
  const [selected, setSelected] = useState<Product | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [catalog, setCatalog] = useState<Product[]>(firebaseConfigured ? [] : products)
  const [wholesaleAuthorized, setWholesaleAuthorized] = useState(false)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [emailVerified, setEmailVerified] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login')
  const [authBusy, setAuthBusy] = useState(false)
  const [signupSuccess, setSignupSuccess] = useState<{ email: string; verificationSent: boolean; profileSaved: boolean } | null>(null)
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPhone, setAuthPhone] = useState('')
  const [smsConsent, setSmsConsent] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [deliveryAddress, setDeliveryAddress] = useState({ fullName: '', phone: '', street: '', city: '', region: '' })
  const [deliveryInstructions, setDeliveryInstructions] = useState('')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [paymentConfirmation, setPaymentConfirmation] = useState<PaymentConfirmation | null>(null)
  const [customerOrders, setCustomerOrders] = useState<CustomerOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState('')
  const results = useMemo(() => catalog.filter((item) => item.stock > 0 && `${item.name} ${item.category} ${item.brand}`.toLowerCase().includes(search.toLowerCase()) && (category === 'All products' || item.category.toLowerCase() === category.toLowerCase())), [catalog, search, category])
  const activeCart = cartOwnerId === (currentUser?.uid ?? null) ? cart : {}
  const items = Object.entries(activeCart).flatMap(([id, quantity]) => { const product = catalog.find((entry) => entry.id === id) ?? products.find((entry) => entry.id === id); return product && quantity > 0 ? [{ product, quantity }] : [] })
  const count = items.reduce((total, item) => total + item.quantity, 0)
  const unitPrice = (product: Product) => mode === 'wholesale' && wholesaleAuthorized ? product.bulkPrice : product.price
  const total = items.reduce((sum, item) => sum + unitPrice(item.product) * item.quantity, 0)

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, (user) => {
      setCurrentUser(user)
      setEmailVerified(user?.emailVerified ?? false)
      setCart(readCart(user?.uid ?? null))
      setCartOwnerId(user?.uid ?? null)
      setAuthReady(true)
    })
  }, [])

  useEffect(() => {
    if (!currentUser) return
    const refreshVerification = async () => {
      const user = auth?.currentUser
      if (!user || user.emailVerified) {
        if (user?.emailVerified) setEmailVerified(true)
        return
      }
      try {
        await reload(user)
        await user.getIdToken(true)
        setEmailVerified(user.emailVerified)
        if (user.emailVerified) {
          setSignupSuccess(null)
          setAuthOpen(false)
          setNotice('Email verified successfully. You can continue shopping.')
        }
      } catch {
        setNotice('Could not refresh email verification. Check your connection and try again.')
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshVerification()
    }
    const returnVerified = new URLSearchParams(window.location.search).get('emailVerified') === '1'
    if (returnVerified) {
      void refreshVerification()
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
    }
    window.addEventListener('focus', onVisibilityChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onVisibilityChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [currentUser])

  useEffect(() => {
    setWholesaleAuthorized(false)
    if (!db || !currentUser) return
    Promise.all([getDoc(doc(db, 'settings', 'commerce')), getDoc(doc(db, 'users', currentUser.uid))]).then(([commerce, profile]) => {
      setWholesaleAuthorized(commerce.get('wholesaleAccess') === 'open' || profile.get('wholesaleStatus') === 'approved')
    }).catch(() => setWholesaleAuthorized(false))
  }, [currentUser])

  useEffect(() => {
    if (wholesaleAuthorized) return
    setSelected(null)
    setCatalog((current) => current.map((product) => product.bulkPrice ? { ...product, bulkPrice: 0 } : product))
  }, [wholesaleAuthorized])

  useEffect(() => {
    if (!db || !wholesaleAuthorized) return
    getDocs(query(collection(db, 'wholesalePricing'), limit(50))).then((snapshot) => {
      const pricing = new Map(snapshot.docs.map((document) => [document.id, document.data()]))
      setCatalog((current) => current.map((product) => {
        const price = pricing.get(product.id)
        return price ? { ...product, bulkPrice: Number(price.wholesalePricePesewas ?? product.price * 100) / 100 } : product
      }))
    }).catch(() => setNotice('Wholesale prices could not be loaded for this account.'))
  }, [wholesaleAuthorized])

  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname
      setView(path === '/admin' ? 'admin' : path === '/wholesale' ? 'wholesale' : path === '/shop' ? 'shop' : path === '/orders' ? 'orders' : 'home')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!db) return
    return onSnapshot(query(collection(db, 'products'), where('publicationStatus', '==', 'published'), where('onlineSaleApproved', '==', true), limit(50)), (snapshot) => {
      setCatalog(snapshot.docs.map((document) => {
        const data = document.data()
        return { id: document.id, name: String(data.name ?? ''), category: String(data.categoryName ?? data.category ?? ''), brand: String(data.brand ?? ''), price: Number(data.retailPricePesewas ?? 0) / 100, bulkPrice: 0, stock: Math.max(0, Number(data.stock ?? 0) - Number(data.reservedStock ?? 0)), image: typeof data.images?.[0] === 'string' ? data.images[0] : String(data.images?.[0]?.url ?? ''), description: String(data.description ?? '') }
      }).filter((product) => product.name && product.image))
    }, () => {
      setCatalog([])
      setNotice('The live catalogue could not be loaded. Check Firebase connection and product query rules.')
    })
  }, [])

  useEffect(() => {
    if (!authReady || cartOwnerId !== (currentUser?.uid ?? null)) return
    localStorage.setItem(cartStorageKey(currentUser?.uid ?? null), JSON.stringify(cart))
  }, [authReady, cart, cartOwnerId, currentUser?.uid])

  useEffect(() => {
    if (view !== 'orders') return
    if (!db || !currentUser) {
      setCustomerOrders([])
      setOrdersLoading(false)
      setOrdersError('')
      return
    }
    setOrdersLoading(true)
    setOrdersError('')
    return onSnapshot(
      query(collection(db, 'orders'), where('customerId', '==', currentUser.uid), orderBy('createdAt', 'desc'), limit(50)),
      (snapshot) => {
        setCustomerOrders(snapshot.docs.map((document) => {
          const data = document.data()
          return {
            id: document.id,
            orderId: String(data.orderId ?? document.id),
            items: Array.isArray(data.items) ? data.items.map((item) => ({
              name: String(item.name ?? 'Product'),
              quantity: Number(item.quantity ?? 0),
              lineTotalPesewas: Number(item.lineTotalPesewas ?? 0),
            })) : [],
            totalPesewas: Number(data.totalPesewas ?? 0),
            paymentStatus: String(data.paymentStatus ?? 'unknown'),
            orderStatus: String(data.orderStatus ?? 'unknown'),
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
          }
        }))
        setOrdersLoading(false)
      },
      () => {
        setOrdersError('Your orders could not be loaded. Please try again later.')
        setOrdersLoading(false)
      },
    )
  }, [currentUser, view])

  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get('reference')
    if (!reference || !currentUser?.emailVerified) return
    let active = true
    let resolved = false
    const clearReference = () => window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
    const completePayment = (payment: { orderId?: string; paymentStatus?: string; orderStatus?: string; items?: OrderLine[]; totalPesewas?: number }) => {
      if (!active || resolved || payment.paymentStatus !== 'success') return false
      resolved = true
      setCart({})
      setCartOpen(false)
      setCheckoutOpen(false)
      setPaymentConfirmation({
        orderId: payment.orderId ?? reference,
        items: payment.items ?? [],
        totalPesewas: Number(payment.totalPesewas ?? 0),
        orderStatus: payment.orderStatus ?? 'payment_confirmed',
      })
      clearReference()
      return true
    }

    const unsubscribeOrder = db ? onSnapshot(doc(db, 'orders', reference), (snapshot) => {
      if (!snapshot.exists() || snapshot.get('customerId') !== currentUser.uid) return
      const paymentStatus = String(snapshot.get('paymentStatus') ?? '')
      if (paymentStatus === 'success') {
        const data = snapshot.data()
        completePayment({
          orderId: String(data.orderId ?? reference),
          paymentStatus,
          orderStatus: String(data.orderStatus ?? 'payment_confirmed'),
          items: Array.isArray(data.items) ? data.items.map((item) => ({
            name: String(item.name ?? 'Product'),
            quantity: Number(item.quantity ?? 0),
            lineTotalPesewas: Number(item.lineTotalPesewas ?? 0),
          })) : [],
          totalPesewas: Number(data.totalPesewas ?? 0),
        })
      } else if (['failed', 'expired'].includes(paymentStatus) && !resolved) {
        resolved = true
        setNotice(`Payment for order ${reference} was not completed. Your cart has been preserved.`)
        clearReference()
      }
    }, () => {
      if (active && !resolved) setNotice('Payment confirmation is still pending. Check your orders shortly.')
    }) : () => {}

    const verifyReturn = async () => {
      try {
        const token = await currentUser.getIdToken(true)
        const response = await fetch('/api/payments/verify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference }),
        })
        const payload = await response.json() as { orderId?: string; paymentStatus?: string; orderStatus?: string; items?: OrderLine[]; totalPesewas?: number; error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Payment verification failed')
        if (!completePayment(payload) && active && !resolved) setNotice('Payment confirmation is pending. This page will update automatically.')
      } catch {
        if (active && !resolved) setNotice('Payment confirmation is still pending. This page will update automatically.')
      }
    }
    void verifyReturn()
    return () => { active = false; unsubscribeOrder() }
  }, [currentUser])

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!auth) { setNotice('Firebase Authentication is not configured.'); return }
    setAuthBusy(true)
    try {
      if (authMode === 'reset') {
        await sendPasswordResetEmail(auth, authEmail)
        setNotice('Password reset instructions have been sent if the account exists.')
        setAuthMode('login')
        return
      }
      if (authMode === 'register') {
        if (authPassword.length < 8) { setNotice('Use a password with at least 8 characters.'); return }
        const credential = await createUserWithEmailAndPassword(auth, authEmail, authPassword)
        let profileSaved = false
        try {
          if (!db) throw new Error('Firestore is not configured')
          await setDoc(doc(db, 'users', credential.user.uid), { fullName: authName.trim(), email: authEmail.trim().toLowerCase(), phone: authPhone.trim(), smsConsent, ...(smsConsent ? { smsConsentAt: serverTimestamp() } : {}), accountStatus: 'active', wholesaleStatus: 'none', createdAt: serverTimestamp() })
          profileSaved = true
        } catch {
          profileSaved = false
        }
        let verificationSent = false
        let verificationError = ''
        try {
          await sendEmailVerification(credential.user, { url: `${window.location.origin}/?emailVerified=1`, handleCodeInApp: false })
          verificationSent = true
        } catch (error) {
          verificationError = emailVerificationError(error)
        }
        setAuthPassword('')
        setAuthMode('login')
        setSignupSuccess({ email: credential.user.email ?? authEmail.trim(), verificationSent, profileSaved })
        setNotice(verificationError)
        if (smsConsent && profileSaved) void requestAuthSms(credential.user, 'signup').then((result) => {
          if (!result.sent) {
            const message = result.reason === 'not_configured' ? 'SMS notifications are not configured on the server.' : 'The account SMS could not be sent. Check the phone number and SMS settings.'
            setNotice((current) => [current, message].filter(Boolean).join(' '))
          }
        }).catch((error) => {
          const message = error instanceof Error ? error.message : 'The account SMS could not be sent.'
          setNotice((current) => [current, message].filter(Boolean).join(' '))
        })
        return
      }
      const credential = await signInWithEmailAndPassword(auth, authEmail, authPassword)
      setAuthOpen(false)
      setSignupSuccess(null)
      setAuthPassword('')
      setEmailVerified(credential.user.emailVerified)
      setNotice(credential.user.emailVerified ? 'Signed in successfully.' : 'Please verify your email before checkout.')
      if (credential.user.emailVerified && cartOpen) setCheckoutOpen(true)
      void requestAuthSms(credential.user, 'login')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      const message = code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')
        ? 'Email or password is incorrect.'
        : code.includes('email-already-in-use')
          ? 'An account already uses this email. Sign in with that account or reset its password.'
          : code.includes('invalid-email')
            ? 'Enter a valid email address.'
            : code.includes('weak-password')
              ? 'Choose a stronger password with at least 8 characters.'
              : code.includes('operation-not-allowed')
                ? 'Email and password sign-in is disabled in Firebase Authentication.'
                : code.includes('network-request-failed') || code.includes('unavailable') || code.includes('permission-denied')
                  ? 'Could not reach the account service. Check the Firebase connection and try again.'
                  : 'Authentication could not be completed. Check your details and try again.'
      setNotice(message)
    } finally {
      setAuthBusy(false)
    }
  }

  async function resendVerification() {
    const user = auth?.currentUser
    if (!user) {
      setNotice('Your account session is still loading. Close this dialog and try again.')
      return
    }
    setAuthBusy(true)
    try {
      await sendEmailVerification(user, { url: `${window.location.origin}/?emailVerified=1`, handleCodeInApp: false })
      setSignupSuccess((current) => current ? { ...current, verificationSent: true } : current)
    } catch (error) {
      const message = emailVerificationError(error)
      setNotice(message)
    } finally {
      setAuthBusy(false)
    }
  }

  async function refreshEmailVerification() {
    const user = auth?.currentUser
    if (!user) {
      setNotice('Sign in again after verifying your email to refresh your account status.')
      return
    }
    setAuthBusy(true)
    try {
      await reload(user)
      await user.getIdToken(true)
      setCurrentUser(user)
      setEmailVerified(user.emailVerified)
      if (user.emailVerified) {
        setSignupSuccess(null)
        setAuthOpen(false)
        setNotice('Email verified successfully. You can continue shopping.')
      } else {
        setNotice('Firebase still reports this email as unverified. Open the latest verification email, then try again.')
      }
    } catch {
      setNotice('Could not check verification status. Check your connection and try again.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function signOutCustomer() {
    if (!auth) return
    setAuthBusy(true)
    try {
      await signOut(auth)
      setAuthOpen(false)
      setSignupSuccess(null)
      setNotice('You have signed out successfully.')
    } catch {
      setNotice('Sign out failed. Check your connection and try again.')
    } finally {
      setAuthBusy(false)
    }
  }

  function startCheckout() {
    if (!items.length) return
    if (mode === 'wholesale' && !wholesaleAuthorized) { setNotice('Wholesale purchasing requires pharmacy approval or an open-access policy.'); return }
    if (!firebaseConfigured) { setNotice('Checkout requires Firebase configuration and a secure Paystack server key.'); return }
    if (!currentUser) { setAuthMode('login'); setAuthOpen(true); return }
    if (!emailVerified) { setNotice('Verify your email before continuing to checkout.'); return }
    setDeliveryAddress((current) => ({ ...current, fullName: current.fullName || currentUser.displayName || '', phone: current.phone || currentUser.phoneNumber || '' }))
    setCheckoutOpen(true)
  }

  async function submitCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser || !emailVerified) { setNotice('Sign in with a verified email before checkout.'); return }
    setCheckoutBusy(true)
    try {
      const token = await currentUser.getIdToken(true)
      const response = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(({ product, quantity }) => ({ productId: product.id, quantity })), mode, address: deliveryAddress, deliveryInstructions }),
      })
      const payload = await response.json() as { orderId?: string; authorizationUrl?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Checkout could not be started.')
      if (!payload.authorizationUrl) throw new Error('Payment provider did not return a checkout link')
      window.location.assign(payload.authorizationUrl)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Checkout could not be started. Please try again.')
      setCheckoutBusy(false)
    }
  }

  function add(product: Product) {
    if (!authReady || cartOwnerId !== (currentUser?.uid ?? null)) {
      setNotice('Please wait while your cart is being loaded.')
      return
    }
    if (mode === 'wholesale' && !wholesaleAuthorized) {
      setNotice(currentUser ? 'Wholesale purchasing requires pharmacy approval or an open-access policy.' : 'Sign in to check wholesale account eligibility.')
      return
    }
    setCart((current) => ({ ...current, [product.id]: Math.min((current[product.id] ?? 0) + 1, product.stock) }))
    setNotice(`${product.name} added to your cart`)
    window.setTimeout(() => setNotice(''), 2600)
  }
  function removeFromCart(productId: string) {
    if (cartOwnerId !== (currentUser?.uid ?? null)) return
    setCart((current) => {
      const next = { ...current }
      delete next[productId]
      return next
    })
  }
  function decreaseQuantity(productId: string) {
    if (cartOwnerId !== (currentUser?.uid ?? null)) return
    setCart((current) => {
      const quantity = current[productId] ?? 0
      if (quantity <= 1) {
        const next = { ...current }
        delete next[productId]
        return next
      }
      return { ...current, [productId]: quantity - 1 }
    })
  }
  function go(next: 'home' | 'shop' | 'wholesale' | 'orders' | 'admin') {
    setView(next); setMobileOpen(false)
    const paths = { home: '/', shop: '/shop', wholesale: '/wholesale', orders: '/orders', admin: '/admin' }
    if (window.location.pathname !== paths[next]) window.history.pushState({}, '', paths[next])
    if (next === 'shop') setCategory('All products')
    if (next === 'wholesale') setMode('wholesale')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (view === 'admin') return <Admin onExit={() => go('home')} currentUser={currentUser} />

  return <div className="app-shell">
    <div className="announcement">Thoughtful care, conveniently close <span>•</span> Serving communities across Ghana</div>
    <header className="site-header"><div className="header-main">
      <button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(!mobileOpen)}><Menu size={21} /></button>
      <button className="brand" onClick={() => go('home')} aria-label="A & O Pharmacy home"><span className="brand-mark"><b>A</b><i>&</i><b>O</b></span><span className="brand-name">A & O <strong>PHARMACY</strong><small>Friendly Service, Expect Advice</small></span></button>
      <nav className={`main-nav ${mobileOpen ? 'is-open' : ''}`} aria-label="Main navigation"><button className={view === 'home' ? 'nav-active' : ''} onClick={() => go('home')}>Home</button><button className={view === 'shop' ? 'nav-active' : ''} onClick={() => go('shop')}>Shop all</button><button onClick={() => { setMode('retail'); go('shop') }}>Retail</button><button className={view === 'wholesale' ? 'nav-active' : ''} onClick={() => go('wholesale')}>Wholesale</button><button className={`nav-orders ${view === 'orders' ? 'nav-active' : ''}`} onClick={() => go('orders')}><ClipboardList size={15}/> Orders</button><a href="#about" onClick={() => setMobileOpen(false)}>About us</a><a href="#contact" onClick={() => setMobileOpen(false)}>Contact</a></nav>
      <div className="header-actions"><label className="header-search"><Search size={17} /><input value={search} onChange={(event) => { setSearch(event.target.value); setView('shop') }} placeholder="Search products" aria-label="Search products" />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={15} /></button>}</label>{currentUser ? <div className="account-controls" role="group" aria-label="Account controls">{isDesignatedAdmin(currentUser) && <button className="admin-shortcut" title="Open admin portal" onClick={() => go('admin')}><ShieldCheck size={15}/><span>Admin</span></button>}<button className={`signed-in-button ${emailVerified ? 'is-verified' : 'needs-verification'}`} title={`Signed in as ${currentUser.email ?? 'customer'}`} onClick={() => { setSignupSuccess(null); setAuthMode('login'); setNotice(''); setAuthOpen(true) }}>{emailVerified ? <CircleCheck size={16}/> : <Mail size={16}/>}<span>{emailVerified ? 'Signed in' : 'Verify email'}</span></button><button className="sign-out-button" title="Sign out" aria-label="Sign out" onClick={signOutCustomer}><LogOut size={17}/><span>Sign out</span></button></div> : <button className="icon-button account-button" title="Customer sign in" aria-label="Customer sign in" onClick={() => { setSignupSuccess(null); setAuthMode('login'); setNotice(''); setAuthOpen(true) }}>A</button>}<button className="icon-button cart-trigger" aria-label={`Open cart, ${count} items`} onClick={() => setCartOpen(true)}><ShoppingBag size={20} /><span className="cart-count">{count}</span></button></div>
    </div></header>
    <main>
      {view === 'home' && <>
        <section className="hero-section"><img className="hero-photo" src="https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1800&q=85" alt="Pharmacist preparing a customer's order" /><div className="hero-shade"/><div className="hero-copy"><h1>Your health,<br/><em>our priority.</em></h1><p>Discover quality healthcare products, everyday essentials and trusted pharmaceutical supplies. Here for your health, whatever the day brings.</p><div className="hero-buttons"><button className="button button-light" onClick={() => go('shop')}>Shop now <ArrowRight size={17}/></button><button className="button button-outline-light" onClick={() => go('wholesale')}>Explore wholesale</button></div></div><div className="hero-index"><span>01</span><i/> A & O PHARMACY</div></section>
        <div className="trust-strip"><div><BadgeCheck/><span>Carefully selected<br/><b>health essentials</b></span></div><div><ShoppingBag/><span>Easy ordering<br/><b>at your pace</b></span></div><div><ShieldCheck/><span>Secure payments<br/><b>when configured</b></span></div><div><Truck/><span>Delivery options<br/><b>coming soon</b></span></div></div>
      </>}
      {view === 'orders' ? <section className="orders-page page-width">
        <div className="orders-heading"><span className="eyebrow">Account activity</span><h1>Your orders</h1><p>Track order progress and payment status. Updates from the pharmacy appear here automatically.</p></div>
        {!currentUser ? <div className="orders-empty"><ClipboardList size={32}/><h2>Sign in to view your orders</h2><p>Your orders are private to your account.</p><button className="button button-green" onClick={() => { setAuthMode('login'); setAuthOpen(true); setNotice('') }}>Sign in to your account <ArrowRight size={16}/></button></div>
          : ordersError ? <p className="orders-error" role="alert">{ordersError}</p>
            : ordersLoading ? <p className="orders-loading" role="status">Loading your orders…</p>
              : customerOrders.length ? <div className="orders-list">{customerOrders.map((order) => <article className="order-card" key={order.id}>
                <header className="order-card-header"><div><span className="eyebrow">Order ID</span><h2>{order.orderId}</h2><time>{orderDateLabel(order.createdAt)}</time></div><div className="order-status"><span className="order-status-badge">{statusLabel(order.orderStatus)}</span><small>Payment: {statusLabel(order.paymentStatus)}</small></div></header>
                <ul className="order-items">{order.items.map((item, index) => <li key={`${order.id}-${index}`}><span>{item.name} <small>× {item.quantity}</small></span><b>{money(item.lineTotalPesewas / 100)}</b></li>)}</ul>
                <div className="order-total"><span>Order total</span><b>{money(order.totalPesewas / 100)}</b></div>
              </article>)}</div>
                : <div className="orders-empty"><ClipboardList size={32}/><h2>No orders yet</h2><p>When you place an order, its status and details will appear here.</p><button className="button button-green" onClick={() => go('shop')}>Explore products <ArrowRight size={16}/></button></div>}
      </section> : <section className={`product-section page-width ${view !== 'home' ? 'shop-page' : ''}`} id="shop"><div className="section-heading product-heading"><div><h2>{view === 'wholesale' ? 'Wholesale essentials' : view === 'shop' ? 'Shop all products' : 'A few favourites'}</h2>{view === 'wholesale' && <p>{wholesaleAuthorized ? 'Bulk ordering is available for this account.' : 'Sign in to check account eligibility and access bulk pricing.'}</p>}</div><button className="text-link" onClick={() => go('shop')}>View all products <ArrowRight size={16}/></button></div>
        <div className="product-controls"><div className="product-tabs"><button className={mode === 'retail' ? 'selected' : ''} onClick={() => { setMode('retail'); if (view === 'wholesale') setView('shop') }}>Retail</button><button className={mode === 'wholesale' ? 'selected' : ''} onClick={() => { setMode('wholesale'); setView('wholesale') }}>Wholesale</button></div><label className="sort-select">Sort by <select aria-label="Sort products"><option>Featured</option><option>Price: low to high</option><option>Price: high to low</option></select></label></div>
        <div className="category-filters"><button className={category === 'All products' ? 'filter-active' : ''} onClick={() => setCategory('All products')}>All products</button>{categories.slice(1).map((name) => <button key={name} className={category.toLowerCase() === name.toLowerCase() ? 'filter-active' : ''} onClick={() => setCategory(name)}>{name}</button>)}</div>
        <div className="product-grid">{results.length ? results.map((product) => <article className="product-card" key={product.id}><div className="product-image"><img src={productImage(product.image)} alt={`${product.name} product`} loading="lazy"/><button className="save-button" aria-label={`Save ${product.name}`} onClick={() => setNotice('Sign in to save products to your list.')}><Heart size={17}/></button><span className="availability"><i/> In stock</span><button className="quick-view" onClick={() => setSelected(product)}>Quick view</button></div><div className="product-info"><span className="product-category">{product.category}</span><h3>{product.name}</h3><span className="product-brand">{product.brand}</span><div className="product-pricing"><b>{money(unitPrice(product))}</b><span>{mode === 'retail' ? wholesaleAuthorized ? `Bulk from ${money(product.bulkPrice)}` : 'Retail price' : wholesaleAuthorized ? 'Wholesale price' : 'Sign in for bulk pricing'}</span></div><button className="add-button" onClick={() => add(product)}>{mode === 'wholesale' && !wholesaleAuthorized ? 'Check eligibility' : 'Add to cart'} <span>+</span></button></div></article>) : <div className="empty-results"><Search size={28}/><h3>No products found</h3><p>Try a different search or category.</p><button className="text-link" onClick={() => { setSearch(''); setCategory('All products') }}>Clear filters <X size={14}/></button></div>}</div>
        {!firebaseConfigured && <div className="catalog-notice"><b>CATALOGUE PREVIEW</b> These sample listings are for development only. Configure Firebase to load products, stock and pricing managed by the pharmacy.</div>}
      </section>}
      {view === 'home' && <>
        <section className="category-section page-width"><div className="section-heading"><div><span className="eyebrow">Find what you need</span><h2>Browse by category</h2></div><button className="text-link" onClick={() => go('shop')}>All categories <ArrowRight size={16}/></button></div><div className="category-grid">{categories.map((name, index) => <button key={name} className={`category-tile cat-${index + 1}`} onClick={() => { setCategory(name); go('shop'); setCategory(name) }}><span className="category-symbol">{['Rx', '+', 'V', 'P', 'B', '✳', 'M', 'H'][index]}</span><span className="category-copy"><b>{name}</b><small>{['Pharmacist review', 'Everyday essentials', 'Daily wellbeing', 'Care from head to toe', 'Gentle essentials', 'Ready for the little things', 'Tools for home care', 'Feel-good favourites'][index]}</small></span><ArrowRight size={16} className="category-arrow"/></button>)}</div></section>
        <section className="promo-band"><div className="promo-inner page-width"><div className="promo-retail"><span className="eyebrow">For your everyday</span><h2>Shop for your<br/>health essentials.</h2><p>Browse individual products and make everyday care a little easier.</p><button className="button button-green" onClick={() => { setMode('retail'); go('shop') }}>Shop retail <ArrowRight size={17}/></button><span className="promo-serial">A&O / RETAIL</span></div><div className="promo-wholesale"><span className="eyebrow">For your business</span><h2>Good supply.<br/>Better together.</h2><p>Quality pharmaceutical supplies and flexible bulk ordering for your business.</p><button className="button button-white" onClick={() => go('wholesale')}>Explore wholesale <ArrowRight size={17}/></button><span className="promo-serial">A&O / WHOLESALE</span></div></div></section>
      </>}
      {view === 'home' && <><section className="why-section" id="about"><div className="page-width why-inner"><div className="why-lead"><span className="eyebrow">A little more personal</span><h2>Care that keeps<br/>you in mind.</h2><p>Good health is personal. So is good pharmacy care. We bring the essentials together with a human touch.</p><a href="#contact" className="text-link">More about us <ArrowRight size={16}/></a></div><div className="benefit-list"><div><span>01</span><section><b>Thoughtfully selected</b><p>Products chosen with everyday wellbeing in mind.</p></section><BadgeCheck/></div><div><span>02</span><section><b>Conveniently yours</b><p>Browse and shop at a time that works for you.</p></section><ShoppingBag/></div><div><span>03</span><section><b>Here when you need us</b><p>Reach our team for support with your questions.</p></section><Heart/></div></div></div></section><section className="newsletter"><div className="newsletter-inner page-width"><div><span className="eyebrow">A note from us</span><h2>Good things, delivered.</h2><p>Join our list for thoughtful health updates and pharmacy news.</p></div><form onSubmit={(event) => { event.preventDefault(); setNotice('Newsletter subscriptions require email service configuration.') }}><input type="email" placeholder="Your email address" aria-label="Email address" required/><button className="button button-green" type="submit">Sign me up <ArrowRight size={17}/></button><small>By subscribing, you agree to our privacy policy.</small></form></div></section></>}
    </main>
    <footer className="site-footer" id="contact"><div className="footer-main page-width"><div className="footer-brand"><span className="brand-mark"><b>A</b><i>&</i><b>O</b></span><h2>A & O PHARMACY</h2><p>Thoughtful care for every day.</p><span className="footer-config">Contact details await business setup.</span></div><div><h3>Explore</h3><button onClick={() => go('shop')}>Shop all</button><button onClick={() => { setMode('retail'); go('shop') }}>Retail pharmacy</button><button onClick={() => go('wholesale')}>Wholesale</button><a href="#about">About us</a></div><div><h3>Help & information</h3><a href="#contact">Contact us</a><a href="#contact">Frequently asked questions</a><a href="#contact">Shipping & delivery</a><a href="#contact">Returns & refunds</a></div><div className="footer-contact"><h3>Get in touch</h3><p>Phone, email and business address will appear here once configured by the pharmacy.</p><button className="admin-link" onClick={() => go('admin')}>Admin workspace <ArrowRight size={15}/></button></div></div><div className="footer-bottom page-width"><span>© 2026 A & O Pharmacy. All rights reserved.</span><div><a href="#contact">Privacy</a><a href="#contact">Terms</a><span>Prices shown in Ghanaian Cedis</span></div></div></footer>
    {cartOpen && <div className="drawer-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setCartOpen(false) }}><aside className="cart-drawer" aria-label="Shopping cart"><div className="drawer-header"><div><span className="eyebrow">Your selection</span><h2>Shopping cart <small>({count})</small></h2></div><button className="icon-button" aria-label="Close cart" onClick={() => setCartOpen(false)}><X size={20}/></button></div>{items.length ? <><div className="cart-lines">{items.map(({ product, quantity }) => <div className="cart-line" key={product.id}><img src={productImage(product.image)} alt=""/><div className="cart-line-info"><b>{product.name}</b><small>{money(mode === 'wholesale' ? product.bulkPrice : product.price)}</small><div className="quantity-control"><button aria-label={`Decrease ${product.name} quantity`} onClick={() => decreaseQuantity(product.id)}>−</button><span>{quantity}</span><button aria-label={`Increase ${product.name} quantity`} onClick={() => add(product)}>+</button></div></div><strong>{money((mode === 'wholesale' ? product.bulkPrice : product.price) * quantity)}</strong><button className="cart-remove-button" aria-label={`Remove ${product.name} from cart`} title="Remove item" onClick={() => removeFromCart(product.id)}><Trash2 size={16}/></button></div>)}</div><div className="cart-summary"><div><span>Subtotal</span><b>{money(total)}</b></div><p>Delivery and final totals are calculated at checkout.</p><button className="button button-green checkout-button" onClick={startCheckout}>Continue to checkout <ArrowRight size={17}/></button><button className="continue-shopping" onClick={() => setCartOpen(false)}>Continue shopping</button></div></> : <div className="empty-cart"><ShoppingBag size={33}/><h3>Your cart is waiting</h3><p>When you find something you need, it will be right here.</p><button className="button button-green" onClick={() => { setCartOpen(false); go('shop') }}>Explore products</button></div>}</aside></div>}
    {selected && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null) }}><div className="product-modal"><button className="icon-button modal-close" aria-label="Close product details" onClick={() => setSelected(null)}><X size={20}/></button><div className="modal-product-image"><img src={productImage(selected.image)} alt={selected.name}/></div><div className="modal-product-copy"><span className="eyebrow">{selected.category}</span><h2>{selected.name}</h2><span className="product-brand">{selected.brand}</span><p>{selected.description}</p><div className="modal-price">{money(mode === 'wholesale' ? selected.bulkPrice : selected.price)} <small>per item</small></div><div className="modal-stock"><i/> {selected.stock} available</div><button className="button button-green" onClick={() => { add(selected); setSelected(null) }}>Add to cart <ArrowRight size={17}/></button></div></div></div>}
    {authOpen && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !authBusy) { setAuthOpen(false); setSignupSuccess(null) } }}><section className="auth-modal" aria-labelledby="auth-title"><button className="icon-button modal-close" type="button" aria-label="Close account dialog" disabled={authBusy} onClick={() => { setAuthOpen(false); setSignupSuccess(null) }}><X size={20}/></button><span className="eyebrow">A & O Pharmacy account</span>{signupSuccess ? <div className="auth-success" role="status"><span className="auth-success-mark"><BadgeCheck size={23}/></span><h2 id="auth-title">Account created successfully</h2><p>Your A & O Pharmacy account was created for:</p><strong className="auth-email-value">{signupSuccess.email}</strong><p className="auth-success-note">You are signed in now. Use this same email and the password you chose whenever you sign in again. Your password is never displayed here.</p>{signupSuccess.verificationSent ? <p className="auth-verification-state">A verification email has been sent. Verify your email before checkout.</p> : <div className="auth-verification-state"><p>We could not send the verification email just now.</p><button className="text-link" type="button" disabled={authBusy} onClick={resendVerification}>{authBusy ? 'Sending…' : 'Resend verification email'}</button></div>}{!signupSuccess.profileSaved && <p className="auth-profile-warning">Your sign-in is ready, but profile details could not be saved. Contact support before placing an order.</p>}<button className="button button-green auth-submit" type="button" onClick={() => { setAuthOpen(false); setSignupSuccess(null) }}>Continue shopping <ArrowRight size={16}/></button></div> : currentUser ? <div className="auth-account-state"><h2 id="auth-title">Your account</h2><p>You are signed in as</p><strong className="auth-email-value">{currentUser.email}</strong><div className={emailVerified ? 'auth-verification-state' : 'auth-profile-warning'}>{emailVerified ? 'Email verified' : 'Email not verified. Verify it before checkout.'}</div>{!emailVerified && <><button className="text-link" type="button" disabled={authBusy} onClick={resendVerification}>{authBusy ? 'Sending…' : 'Resend verification email'}</button><button className="button button-green auth-submit" type="button" disabled={authBusy} onClick={refreshEmailVerification}>{authBusy ? 'Checking verification…' : "I've verified my email"} <ArrowRight size={16}/></button></>}<button className="button button-outline-account auth-submit" type="button" disabled={authBusy} onClick={signOutCustomer}>{authBusy ? 'Signing out…' : 'Sign out'} <ArrowRight size={16}/></button></div> : <><h2 id="auth-title">{authMode === 'register' ? 'Create your account' : authMode === 'reset' ? 'Reset your password' : 'Welcome back'}</h2><p>{authMode === 'register' ? 'Your account keeps your orders and delivery details together.' : authMode === 'reset' ? 'We will send a secure reset link to your email.' : 'Sign in to continue to your account and checkout.'}</p><form onSubmit={submitAuth}>{authMode === 'register' && <><label>Full name<input required value={authName} onChange={(event) => setAuthName(event.target.value)} autoComplete="name" disabled={authBusy}/></label><label>Phone number<input required type="tel" value={authPhone} onChange={(event) => setAuthPhone(event.target.value)} autoComplete="tel" disabled={authBusy}/></label><label className="sms-consent"><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} disabled={authBusy}/><span>Send me account, order and payment updates by SMS. Message and data rates may apply. Contact the pharmacy to opt out.</span></label></>}<label>Email address<input required type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} autoComplete="email" disabled={authBusy}/></label>{authMode !== 'reset' && <label>Password<input required minLength={8} type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} disabled={authBusy}/></label>}{notice && <p className="auth-inline-error" role="alert">{notice}</p>}<button className="button button-green auth-submit" type="submit" disabled={authBusy}>{authBusy ? authMode === 'register' ? 'Creating account…' : authMode === 'reset' ? 'Sending reset link…' : 'Signing in…' : authMode === 'register' ? 'Create account' : authMode === 'reset' ? 'Send reset link' : 'Sign in'} {!authBusy && <ArrowRight size={16}/>}</button></form><div className="auth-links">{authMode === 'login' ? <><button type="button" disabled={authBusy} onClick={() => { setNotice(''); setAuthMode('reset') }}>Forgot password?</button><button type="button" disabled={authBusy} onClick={() => { setNotice(''); setAuthMode('register') }}>Create an account</button></> : <button type="button" disabled={authBusy} onClick={() => { setNotice(''); setAuthMode('login') }}>Back to sign in</button>}</div><small className="auth-config-note">Use the same email address and password every time you sign in.</small></>}</section></div>}
    {checkoutOpen && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setCheckoutOpen(false) }}><form className="checkout-modal" onSubmit={submitCheckout}><div className="checkout-head"><div><span className="eyebrow">Secure order</span><h2>Delivery details</h2></div><button className="icon-button" type="button" aria-label="Close checkout" onClick={() => setCheckoutOpen(false)}><X size={20}/></button></div><div className="checkout-fields"><label>Full name<input required value={deliveryAddress.fullName} onChange={(event) => setDeliveryAddress({ ...deliveryAddress, fullName: event.target.value })} autoComplete="name"/></label><label>Phone number<input required type="tel" value={deliveryAddress.phone} onChange={(event) => setDeliveryAddress({ ...deliveryAddress, phone: event.target.value })} autoComplete="tel"/></label><label className="field-wide">Street address<input required value={deliveryAddress.street} onChange={(event) => setDeliveryAddress({ ...deliveryAddress, street: event.target.value })} autoComplete="street-address"/></label><label>City / town<input required value={deliveryAddress.city} onChange={(event) => setDeliveryAddress({ ...deliveryAddress, city: event.target.value })}/></label><label>Region<input required value={deliveryAddress.region} onChange={(event) => setDeliveryAddress({ ...deliveryAddress, region: event.target.value })}/></label><label className="field-wide">Delivery instructions <textarea value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} rows={2}/></label></div><div className="checkout-total"><span>Estimated total <small>GHS, verified by the server</small></span><b>{money(total)}</b></div><p className="checkout-disclaimer">The server rechecks current prices, stock and eligibility before opening Paystack. Prescription items require pharmacist approval and cannot be paid for through this flow.</p><button className="button button-green checkout-button" type="submit" disabled={checkoutBusy}>{checkoutBusy ? 'Preparing secure payment…' : 'Continue to Paystack'} <ArrowRight size={17}/></button></form></div>}
    {paymentConfirmation && <div className="modal-scrim order-confirmation-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaymentConfirmation(null) }}><section className="order-confirmation" role="dialog" aria-modal="true" aria-labelledby="order-confirmation-title"><button className="icon-button modal-close" aria-label="Close order confirmation" onClick={() => setPaymentConfirmation(null)}><X size={20}/></button><span className="order-confirmation-mark"><CircleCheck size={26}/></span><span className="eyebrow">Payment confirmed</span><h2 id="order-confirmation-title">Thank you for your order</h2><p className="confirmation-order-id">Order ID <strong>{paymentConfirmation.orderId}</strong></p><div className="confirmation-items">{paymentConfirmation.items.map((item, index) => <div className="confirmation-item" key={`${paymentConfirmation.orderId}-${index}`}><span>{item.name} <small>× {item.quantity}</small></span><b>{money(item.lineTotalPesewas / 100)}</b></div>)}</div><div className="confirmation-total"><span>Total paid</span><strong>{money(paymentConfirmation.totalPesewas / 100)}</strong></div><p className="confirmation-status">Current status: <b>{statusLabel(paymentConfirmation.orderStatus)}</b></p><div className="confirmation-actions"><button className="button button-green" onClick={() => { setPaymentConfirmation(null); go('orders') }}>Track my order <ArrowRight size={16}/></button><button className="continue-shopping" onClick={() => setPaymentConfirmation(null)}>Continue shopping</button></div></section></div>}
    {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16}/></button></div>}
  </div>
}

function Admin({ onExit, currentUser }: { onExit: () => void; currentUser: User | null }) {
  const [adminAccess, setAdminAccess] = useState<'checking' | 'allowed' | 'denied' | 'preview'>(firebaseConfigured ? 'checking' : 'preview')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [adminError, setAdminError] = useState('')
  const [adminBusy, setAdminBusy] = useState(false)
  useEffect(() => {
    let active = true
    if (!firebaseConfigured) { setAdminAccess('preview'); return }
    if (!currentUser) { setAdminAccess('denied'); return }
    setAdminAccess('checking')
    reload(currentUser).then(() => {
      if (active) setAdminAccess(isDesignatedAdmin(currentUser) ? 'allowed' : 'denied')
    }).catch(() => { if (active) setAdminAccess('denied') })
    return () => { active = false }
  }, [currentUser])

  async function adminLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!auth) return
    setAdminBusy(true)
    setAdminError('')
    try {
      const credential = await signInWithEmailAndPassword(auth, adminEmail, adminPassword)
      await reload(credential.user)
      if (!isDesignatedAdmin(credential.user)) {
        await signOut(auth)
        setAdminError('Only the designated email-verified pharmacy account can access this portal.')
        setAdminAccess('denied')
      } else {
        setAdminAccess('allowed')
      }
    } catch {
      setAdminError('Sign-in failed. Check your credentials and administrator access.')
    } finally { setAdminBusy(false) }
  }

  if (!firebaseConfigured) return <main className="admin-gate"><section className="admin-gate-card"><button type="button" className="admin-back" onClick={onExit}>← Storefront</button><span className="brand-mark"><b>A</b><i>&</i><b>O</b></span><span className="eyebrow">A & O Pharmacy</span><h1>Admin setup required</h1><p>This private workspace is unavailable until Firebase Authentication, server-provisioned admin access and the pharmacy database are configured. No dashboard data is exposed in preview mode.</p><button className="button button-green" onClick={onExit}>Return to storefront <ArrowRight size={16}/></button></section></main>
  if (firebaseConfigured && adminAccess !== 'allowed' && adminAccess !== 'preview') return <main className="admin-gate"><form onSubmit={adminLogin}><button type="button" className="admin-back" onClick={onExit}>← Storefront</button><span className="brand-mark"><b>A</b><i>&</i><b>O</b></span><span className="eyebrow">A & O Pharmacy</span><h1>{adminAccess === 'checking' ? 'Checking access' : 'Administrator sign in'}</h1><p>{adminAccess === 'checking' ? 'Verifying your account.' : 'Only the designated, email-verified pharmacy account can enter this workspace.'}</p>{adminAccess !== 'checking' && <><label>Email address<input type="email" required value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="username"/></label><label>Password<input type="password" required value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="current-password"/></label>{adminError && <span className="admin-login-error" role="alert">{adminError}</span>}<button className="button button-green" type="submit" disabled={adminBusy}>{adminBusy ? 'Signing in…' : 'Sign in securely'} <ArrowRight size={16}/></button><small>Use the same account you use on the storefront.</small></>}</form></main>
  return <AdminPortal adminEmail={currentUser?.email ?? ''} onExit={onExit} />
}

export default App