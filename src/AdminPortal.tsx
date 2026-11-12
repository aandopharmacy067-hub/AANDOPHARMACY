import { useEffect, useState, type FormEvent } from 'react'
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore'
import { ArrowRight, BadgeCheck, Box, CalendarDays, ClipboardList, CreditCard, ImagePlus, LogOut, MessageSquareText, PackagePlus, RefreshCw, ShieldCheck, ShoppingCart, Users } from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth, db } from './lib/firebase'
import './admin-live.css'
import './admin-details.css'

type AdminProduct = {
  id: string
  name: string
  sku: string
  categoryName: string
  brand: string
  retailPricePesewas: number
  stock: number
  reservedStock: number
  publicationStatus: string
  onlineSaleApproved: boolean
  prescriptionRequired: boolean
  images: Array<{ url: string; alt?: string }>
  featured: boolean
}

type AdminOrder = {
  id: string
  orderId: string
  customerId: string
  mode: string
  totalPesewas: number
  paymentStatus: string
  orderStatus: string
  createdAt?: { toDate?: () => Date }
  paidAt?: { toDate?: () => Date }
  deliveryInstructions?: string
  address?: { fullName?: string; phone?: string; street?: string; city?: string; region?: string }
  items?: Array<{ name: string; quantity: number; lineTotalPesewas?: number }>
}

type AdminUser = {
  id: string
  fullName: string
  email: string
  phone: string
  smsConsent: boolean
  accountStatus: string
  createdAt?: { toDate?: () => Date }
}

type AdminReview = {
  id: string
  productId: string
  customerId: string
  rating: number
  text: string
  status: string
  createdAt?: { toDate?: () => Date }
}

const categories = ['Prescription Medicines', 'Over-the-Counter Medicines', 'Vitamins & Supplements', 'Personal Care', 'Baby & Mother Care', 'First Aid', 'Medical Equipment', 'Health & Wellness']
const orderStatuses = ['payment_confirmed', 'processing', 'ready_for_dispatch', 'out_for_delivery', 'completed', 'cancelled', 'refund_pending', 'refunded']
const currency = (pesewas: number) => `GH₵ ${(pesewas / 100).toFixed(2)}`
const dateLabel = (timestamp?: { toDate?: () => Date }) => timestamp?.toDate ? timestamp.toDate().toLocaleString() : 'Just now'
const localDayStart = (date: Date) => {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  return start
}
const isValidGhanaPhone = (value: string) => {
  const digits = value.trim().replace(/[^\d+]/g, '')
  const local = digits.startsWith('+233') ? `0${digits.slice(4)}` : digits.startsWith('233') ? `0${digits.slice(3)}` : digits
  return /^0\d{9}$/.test(local)
}

async function compressProductImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not process the selected image.')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  let quality = 0.82
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Image compression failed. Choose a different image.')), 'image/webp', quality)
    })
    if (blob.size <= 350 * 1024) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the compressed image.'))
        reader.onerror = () => reject(new Error('Could not read the compressed image.'))
        reader.readAsDataURL(blob)
      })
      return dataUrl
    }
    quality -= 0.06
    if (quality < 0.58) {
      canvas.width = Math.max(1, Math.round(canvas.width * 0.82))
      canvas.height = Math.max(1, Math.round(canvas.height * 0.82))
      quality = 0.76
    }
  }
  throw new Error('Could not compress this image below 350 KB. Choose a smaller image.')
}

export default function AdminPortal({ adminEmail, onExit }: { adminEmail: string; onExit: () => void }) {
  const [section, setSection] = useState<'Overview' | 'Products' | 'Orders' | 'Reviews' | 'Users'>('Overview')
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [todayOrders, setTodayOrders] = useState<AdminOrder[]>([])
  const [paymentsToday, setPaymentsToday] = useState<AdminOrder[]>([])
  const [todayStart, setTodayStart] = useState(() => localDayStart(new Date()))
  const [reviews, setReviews] = useState<AdminReview[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [feedError, setFeedError] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [name, setName] = useState('')
  const [brand, setBrand] = useState('')
  const [category, setCategory] = useState(categories[2])
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [publish, setPublish] = useState(false)
  const [saleApproved, setSaleApproved] = useState(false)
  const [prescriptionRequired, setPrescriptionRequired] = useState(false)
  const [featured, setFeatured] = useState(false)
  const [uploadStage, setUploadStage] = useState<'idle' | 'optimizing' | 'saving'>('idle')

  useEffect(() => {
    let timer = 0
    const scheduleNextDay = () => {
      const now = new Date()
      const nextDay = localDayStart(now)
      nextDay.setDate(nextDay.getDate() + 1)
      timer = window.setTimeout(() => {
        setTodayStart(localDayStart(new Date()))
        scheduleNextDay()
      }, nextDay.getTime() - now.getTime())
    }
    scheduleNextDay()
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!db) return
    const unsubscribers = [
      onSnapshot(query(collection(db, 'products'), orderBy('name'), limit(200)), (snapshot) => {
        setProducts(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as AdminProduct))
        setFeedError('')
      }, (error) => setFeedError(`Products: ${error.message}`)),
      onSnapshot(query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(100)), (snapshot) => {
        setOrders(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as AdminOrder))
      }, (error) => setFeedError(`Orders: ${error.message}`)),
      onSnapshot(query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(100)), (snapshot) => {
        setReviews(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as AdminReview))
      }, (error) => setFeedError(`Reviews: ${error.message}`)),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

  useEffect(() => {
    if (!db) return
    const start = Timestamp.fromDate(todayStart)
    const unsubscribers = [
      onSnapshot(query(collection(db, 'orders'), where('createdAt', '>=', start), orderBy('createdAt', 'desc')), (snapshot) => {
        setTodayOrders(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as AdminOrder))
      }, (error) => setFeedError(`Today's orders: ${error.message}`)),
      onSnapshot(query(collection(db, 'orders'), where('paidAt', '>=', start), orderBy('paidAt', 'desc')), (snapshot) => {
        setPaymentsToday(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as AdminOrder))
      }, (error) => setFeedError(`Today's sales: ${error.message}`)),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [todayStart])

  useEffect(() => {
    if (!db || section !== 'Users') return
    setUsersLoading(true)
    setUsersError('')
    return onSnapshot(collection(db, 'users'), (snapshot) => {
      const currentUsers = snapshot.docs.map((entry) => {
        const data = entry.data()
        return {
          id: entry.id,
          fullName: String(data.fullName ?? ''),
          email: String(data.email ?? ''),
          phone: String(data.phone ?? ''),
          smsConsent: data.smsConsent === true,
          accountStatus: String(data.accountStatus ?? 'unknown'),
          createdAt: data.createdAt,
        }
      }).sort((first, second) => (second.createdAt?.toDate?.().getTime() ?? 0) - (first.createdAt?.toDate?.().getTime() ?? 0))
      setUsers(currentUsers)
      setUsersLoading(false)
    }, (error) => {
      setUsersError(`Users: ${error.message}`)
      setUsersLoading(false)
    })
  }, [section])

  async function addProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!db || !image) {
      setFeedback('Firestore is unavailable. Check Firebase setup and select a product image.')
      return
    }
    if (!Number.isFinite(Number(price)) || Number(price) <= 0 || !Number.isInteger(Number(stock)) || Number(stock) < 0) {
      setFeedback('Enter a valid price and a whole-number stock quantity.')
      return
    }
    if (image.size > 10 * 1024 * 1024 || !image.type.startsWith('image/')) {
      setFeedback('Choose an image under 10 MB.')
      return
    }
    setBusy(true)
    setUploadStage('optimizing')
    setFeedback('')
    try {
      const imageDataUrl = await compressProductImage(image)
      setUploadStage('saving')
      const productRef = doc(collection(db, 'products'))
      const sku = `AO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
      await setDoc(productRef, {
        name: name.trim(), sku, brand: brand.trim(), categoryName: category,
        description: '', images: [{ url: imageDataUrl, alt: name.trim() }],
        retailPricePesewas: Math.round(Number(price) * 100), stock: Number(stock), reservedStock: 0,
        publicationStatus: publish && saleApproved ? 'published' : 'draft', onlineSaleApproved: saleApproved,
        prescriptionRequired, featured, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      })
      setFeedback(publish && saleApproved ? 'Product saved and published. It is now syncing to the storefront.' : 'Product saved as a draft. Publish it and approve online sale to show it in the storefront.')
      setName(''); setBrand(''); setPrice(''); setStock(''); setImage(null); setPublish(false); setSaleApproved(false); setPrescriptionRequired(false); setFeatured(false)
      const fileInput = document.querySelector<HTMLInputElement>('#admin-product-image')
      if (fileInput) fileInput.value = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      setFeedback(`Product could not be saved: ${message}`)
    } finally {
      setBusy(false)
      setUploadStage('idle')
    }
  }

  async function setProductPublished(product: AdminProduct) {
    if (!db) return
    const next = product.publicationStatus === 'published' ? 'draft' : 'published'
    const approveForSale = next === 'published' && !product.onlineSaleApproved
    try {
      await updateDoc(doc(db, 'products', product.id), { publicationStatus: next, ...(approveForSale ? { onlineSaleApproved: true } : {}), updatedAt: serverTimestamp() })
      setFeedback(next === 'published' ? 'Product approved and published to the storefront.' : 'Product moved to draft and removed from the storefront.')
    } catch {
      setFeedback('Could not update publication status. Confirm admin permissions and try again.')
    }
  }

  async function setOrderStatus(order: AdminOrder, orderStatus: string) {
    if (!db || orderStatus === order.orderStatus) return
    try {
      await updateDoc(doc(db, 'orders', order.id), { orderStatus, updatedAt: serverTimestamp() })
      setFeedback(`Order ${order.orderId} updated.`)
    } catch {
      setFeedback('Could not update the order. The order status rule may need deployment or the account may lack admin access.')
    }
  }

  async function moderateReview(review: AdminReview, status: 'approved' | 'hidden') {
    if (!db) return
    try {
      await updateDoc(doc(db, 'reviews', review.id), { status })
      setFeedback(`Review ${status}.`)
    } catch {
      setFeedback('Could not moderate this review. Confirm admin permissions and try again.')
    }
  }

  const nav: Array<{ label: typeof section; icon: typeof Box }> = [
    { label: 'Overview', icon: BadgeCheck },
    { label: 'Products', icon: Box },
    { label: 'Orders', icon: ClipboardList },
    { label: 'Users', icon: Users },
    { label: 'Reviews', icon: MessageSquareText },
  ]
  const pendingOrders = orders.filter((order) => ['pending_payment', 'payment_confirmed', 'processing'].includes(order.orderStatus)).length
  const paidTotal = orders.filter((order) => order.paymentStatus === 'success').reduce((sum, order) => sum + Number(order.totalPesewas ?? 0), 0)
  const paymentIdsToday = new Set(paymentsToday.map((order) => order.id))
  const salesToday = paymentsToday.filter((order) => order.paymentStatus === 'success').reduce((sum, order) => sum + Number(order.totalPesewas ?? 0), 0)
    + todayOrders.filter((order) => order.paymentStatus === 'success' && !order.paidAt && !paymentIdsToday.has(order.id)).reduce((sum, order) => sum + Number(order.totalPesewas ?? 0), 0)

  return <main className="admin-layout"><aside className="admin-sidebar"><button className="admin-brand" onClick={onExit}><span className="brand-mark"><b>A</b><i>&</i><b>O</b></span><span><b>A & O</b><small>ADMINISTRATION</small></span></button><span className="admin-section-title">WORKSPACE</span><nav>{nav.map(({ label, icon: Icon }) => <button key={label} className={section === label ? 'admin-nav-active' : ''} onClick={() => setSection(label)}><Icon size={16}/>{label}</button>)}</nav><div className="admin-profile"><span className="admin-avatar">AO</span><div><b>Authorized admin</b><small>{adminEmail}</small></div><button title="Sign out" aria-label="Admin sign out" onClick={() => { if (!auth) { onExit(); return } void signOut(auth).then(onExit).catch(() => setFeedback('Sign out failed. Try again.')) }}><LogOut size={15}/></button></div></aside><section className="admin-main"><header className="admin-topbar"><div><span>Administration / Live workspace</span><h1>{section}</h1></div><span className="admin-live-indicator"><i/> Live Firebase data</span></header><div className="admin-content">{feedError && <div className="admin-feed-error" role="alert"><ShieldCheck size={18}/>{feedError} Check deployed Firestore rules and indexes.</div>}{feedback && <div className="admin-feedback" role="status">{feedback}<button type="button" onClick={() => setFeedback('')} aria-label="Dismiss message">×</button></div>}
    {section === 'Overview' && <><div className="admin-stat-grid">
      <div className="admin-stat admin-stat-premium"><div className="admin-stat-header"><span>Paid sales</span><CreditCard size={19}/></div><strong>{currency(paidTotal)}</strong><small>Latest 100 orders</small></div>
      <div className="admin-stat"><span>Total orders</span><strong>{orders.length}</strong><small>Most recent 100</small></div>
      <div className="admin-stat"><span>Pending / active</span><strong>{pendingOrders}</strong><small>Current queue</small></div>
      <div className="admin-stat"><span>Products</span><strong>{products.length}</strong><small>Live catalogue records</small></div>
      <div className="admin-stat admin-stat-daily admin-stat-daily-sales"><div className="admin-stat-header"><span>Sales Today</span><CalendarDays size={19}/></div><strong>{currency(salesToday)}</strong><small>Successful payments confirmed today</small></div>
      <div className="admin-stat admin-stat-daily admin-stat-daily-orders"><div className="admin-stat-header"><span>Orders Today</span><ShoppingCart size={19}/></div><strong>{todayOrders.length}</strong><small>Orders placed today</small></div>
    </div><div className="admin-panel"><div className="panel-heading"><div><h2>Recent orders</h2><span>Live Firestore updates</span></div><button onClick={() => setSection('Orders')}>All orders <ArrowRight size={14}/></button></div><OrdersList orders={orders.slice(0, 8)} onStatusChange={setOrderStatus}/></div><div className="admin-panel"><div className="panel-heading"><div><h2>Recent customer feedback</h2><span>Live Firestore reviews</span></div><button onClick={() => setSection('Reviews')}>All reviews <ArrowRight size={14}/></button></div><ReviewsList reviews={reviews.slice(0, 5)} onModerate={moderateReview}/></div></>}
    {section === 'Products' && <><div className="admin-panel"><div className="panel-heading"><div><h2>Add a product</h2><span>Uploaded images and approved listings sync to the storefront.</span></div><PackagePlus size={19}/></div><form className="admin-product-form" onSubmit={addProduct}><label>Product name<input required value={name} onChange={(event) => setName(event.target.value)} maxLength={120}/></label><label>Brand / manufacturer<input value={brand} onChange={(event) => setBrand(event.target.value)} maxLength={100}/></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((option) => <option key={option}>{option}</option>)}</select></label><label>Retail price (GHS)<input required type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)}/></label><label>Available stock<input required type="number" min="0" step="1" value={stock} onChange={(event) => setStock(event.target.value)}/></label><label className="admin-field-wide admin-image-field"><span>Product image (source max 10 MB)</span><input id="admin-product-image" required type="file" accept="image/*" onChange={(event) => setImage(event.target.files?.[0] ?? null)}/><small>{image ? image.name : 'The image is compressed to fit safely in Firestore.'}</small></label><div className="admin-check-options"><label><input type="checkbox" checked={saleApproved} onChange={(event) => setSaleApproved(event.target.checked)}/> Approved for online sale</label><label><input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)}/> Publish to storefront</label><label><input type="checkbox" checked={prescriptionRequired} onChange={(event) => setPrescriptionRequired(event.target.checked)}/> Prescription required</label><label><input type="checkbox" checked={featured} onChange={(event) => setFeatured(event.target.checked)}/> Featured</label></div><p className="admin-form-note">A listing appears publicly only when both approval and publish are selected. Prescription-required products remain blocked from checkout.</p>{busy && <div className="admin-upload-progress" role="status"><span>{uploadStage === 'optimizing' ? 'Optimizing image for Firestore…' : 'Saving product and image to Firestore…'}</span><progress/></div>}<button className="button button-green" type="submit" disabled={busy || (publish && !saleApproved)}>{busy ? uploadStage === 'optimizing' ? 'Optimizing image…' : 'Saving product…' : <><ImagePlus size={16}/> Save product</>}</button></form></div><div className="admin-panel"><div className="panel-heading"><div><h2>Catalogue</h2><span>{products.length} live records, including drafts</span></div><RefreshCw size={17}/></div><div className="admin-product-list">{products.map((product) => <div className="admin-product-row" key={product.id}><img src={product.images?.[0]?.url ?? ''} alt=""/><div className="admin-product-description"><b>{product.name}</b><small>{product.sku} · {product.categoryName} · Stock {product.stock}</small></div><strong>{currency(product.retailPricePesewas)}</strong><span className={`admin-product-status ${product.publicationStatus === 'published' && product.onlineSaleApproved ? 'is-published' : ''}`}>{product.publicationStatus === 'published' && product.onlineSaleApproved ? 'Published' : 'Draft'}</span><button className="admin-small-action" onClick={() => void setProductPublished(product)}>{product.publicationStatus === 'published' ? 'Unpublish' : product.onlineSaleApproved ? 'Publish' : 'Approve & publish'}</button></div>)}{products.length === 0 && <p className="admin-empty-state">No products yet. Add one above to begin.</p>}</div></div></>}
    {section === 'Orders' && <div className="admin-panel"><div className="panel-heading"><div><h2>Order management</h2><span>Live orders, delivery details and status changes</span></div><RefreshCw size={17}/></div><OrdersList orders={orders} onStatusChange={setOrderStatus}/></div>}
    {section === 'Users' && <div className="admin-panel"><div className="panel-heading"><div><h2>Registered users</h2><span>Customer contact and SMS consent details</span></div><strong className="admin-user-count">{users.length} users</strong></div><p className="admin-users-note">SMS messages use the phone number on each customer profile and are sent only when SMS updates are opted in and the number is valid for Ghana.</p>{usersError ? <p className="admin-feed-error" role="alert">{usersError}</p> : usersLoading ? <p className="admin-empty-state" role="status">Loading registered users…</p> : users.length ? <div className="admin-users-grid">{users.map((user) => <article className="admin-user-card" key={user.id}><header><div><h3>{user.fullName || 'Name not provided'}</h3><time>{dateLabel(user.createdAt)}</time></div><span className="admin-user-status">{user.accountStatus.replaceAll('_', ' ')}</span></header><dl><div><dt>Email</dt><dd>{user.email || 'Not provided'}</dd></div><div><dt>Phone</dt><dd>{user.phone || 'Not provided'}</dd></div><div><dt>SMS updates</dt><dd className={user.smsConsent && isValidGhanaPhone(user.phone) ? 'sms-ready' : 'sms-needs-attention'}>{!user.smsConsent ? 'Not opted in' : isValidGhanaPhone(user.phone) ? 'Opted in · valid Ghana number' : 'Opted in · check phone number'}</dd></div></dl></article>)}</div> : <p className="admin-empty-state">No registered users found.</p>}</div>}
    {section === 'Reviews' && <div className="admin-panel"><div className="panel-heading"><div><h2>Customer feedback</h2><span>Moderate live review submissions</span></div><RefreshCw size={17}/></div><ReviewsList reviews={reviews} onModerate={moderateReview}/></div>}
    <p className="admin-disclaimer">Live data is read from the selected Firebase project. Product publication and order/review updates require deployed admin Firestore/Storage rules.</p></div></section></main>
}

function OrdersList({ orders, onStatusChange }: { orders: AdminOrder[]; onStatusChange: (order: AdminOrder, status: string) => void }) {
  return orders.length ? <div className="admin-orders-list">{orders.map((order) => <article className="admin-order-card" key={order.id}>
    <header className="admin-order-header"><div><span>Order ID</span><strong>{order.orderId || order.id}</strong><time>{dateLabel(order.createdAt)}</time></div><div><span>Payment</span><b className="admin-status-pill">{order.paymentStatus}</b></div><div><span>Total</span><strong>{currency(Number(order.totalPesewas ?? 0))}</strong></div><label><span>Fulfillment</span><select aria-label={`Set status for ${order.orderId || order.id}`} value={order.orderStatus || 'pending_payment'} onChange={(event) => onStatusChange(order, event.target.value)}>{[...new Set([order.orderStatus || 'pending_payment', ...orderStatuses])].map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></label></header>
    <div className="admin-order-details"><section><h3>Items purchased</h3>{order.items?.length ? <ul>{order.items.map((item, index) => <li key={`${order.id}-${index}`}><span>{item.name || 'Product'} <b>× {item.quantity}</b></span>{typeof item.lineTotalPesewas === 'number' && <strong>{currency(item.lineTotalPesewas)}</strong>}</li>)}</ul> : <p>No item details saved for this order.</p>}</section><section><h3>Delivery details</h3>{order.address ? <address><b>{order.address.fullName || 'Name not provided'}</b><span>{order.address.phone || 'Phone not provided'}</span><span>{order.address.street || 'Street not provided'}</span><span>{[order.address.city, order.address.region].filter(Boolean).join(', ') || 'Location not provided'}</span>{order.deliveryInstructions && <small>Instructions: {order.deliveryInstructions}</small>}</address> : <p>No delivery details saved for this order.</p>}</section></div>
  </article>)}</div> : <p className="admin-empty-state">No orders yet. Orders will appear here as soon as they are created.</p>
}

function ReviewsList({ reviews, onModerate }: { reviews: AdminReview[]; onModerate: (review: AdminReview, status: 'approved' | 'hidden') => void }) {
  return <div className="admin-review-list">{reviews.map((review) => <article className="admin-review-row" key={review.id}><div className="admin-review-meta"><b>{'★'.repeat(Math.max(0, Math.min(5, review.rating)))}</b><span>{review.status}</span><time>{dateLabel(review.createdAt)}</time></div><p>{review.text}</p><small>Product {review.productId} · Customer {review.customerId}</small><div className="admin-review-actions"><button onClick={() => onModerate(review, 'approved')}>Approve</button><button onClick={() => onModerate(review, 'hidden')}>Hide</button></div></article>)}{reviews.length === 0 && <p className="admin-empty-state">No customer feedback has been submitted yet.</p>}</div>
}
