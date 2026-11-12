import { useEffect, useState, type FormEvent } from 'react'
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { ArrowRight, BadgeCheck, Box, ClipboardList, ImagePlus, LogOut, MessageSquareText, PackagePlus, RefreshCw, ShieldCheck } from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth, db } from './lib/firebase'
import './admin-live.css'

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
  items?: Array<{ name: string; quantity: number }>
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
  const [section, setSection] = useState<'Overview' | 'Products' | 'Orders' | 'Reviews'>('Overview')
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [reviews, setReviews] = useState<AdminReview[]>([])
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
    { label: 'Reviews', icon: MessageSquareText },
  ]
  const pendingOrders = orders.filter((order) => ['pending_payment', 'payment_confirmed', 'processing'].includes(order.orderStatus)).length
  const paidTotal = orders.filter((order) => order.paymentStatus === 'success').reduce((sum, order) => sum + Number(order.totalPesewas ?? 0), 0)

  return <main className="admin-layout"><aside className="admin-sidebar"><button className="admin-brand" onClick={onExit}><span className="brand-mark"><b>A</b><i>&</i><b>O</b></span><span><b>A & O</b><small>ADMINISTRATION</small></span></button><span className="admin-section-title">WORKSPACE</span><nav>{nav.map(({ label, icon: Icon }) => <button key={label} className={section === label ? 'admin-nav-active' : ''} onClick={() => setSection(label)}><Icon size={16}/>{label}</button>)}</nav><div className="admin-profile"><span className="admin-avatar">AO</span><div><b>Authorized admin</b><small>{adminEmail}</small></div><button title="Sign out" aria-label="Admin sign out" onClick={() => { if (!auth) { onExit(); return } void signOut(auth).then(onExit).catch(() => setFeedback('Sign out failed. Try again.')) }}><LogOut size={15}/></button></div></aside><section className="admin-main"><header className="admin-topbar"><div><span>Administration / Live workspace</span><h1>{section}</h1></div><span className="admin-live-indicator"><i/> Live Firebase data</span></header><div className="admin-content">{feedError && <div className="admin-feed-error" role="alert"><ShieldCheck size={18}/>{feedError} Check deployed Firestore rules and indexes.</div>}{feedback && <div className="admin-feedback" role="status">{feedback}<button type="button" onClick={() => setFeedback('')} aria-label="Dismiss message">×</button></div>}
    {section === 'Overview' && <><div className="admin-stat-grid"><div className="admin-stat"><span>Paid sales</span><strong>{currency(paidTotal)}</strong><small>Loaded orders</small></div><div className="admin-stat"><span>Total orders</span><strong>{orders.length}</strong><small>Most recent 100</small></div><div className="admin-stat"><span>Pending / active</span><strong>{pendingOrders}</strong><small>Current queue</small></div><div className="admin-stat"><span>Products</span><strong>{products.length}</strong><small>Live catalogue records</small></div></div><div className="admin-panel"><div className="panel-heading"><div><h2>Recent orders</h2><span>Live Firestore updates</span></div><button onClick={() => setSection('Orders')}>All orders <ArrowRight size={14}/></button></div><OrdersTable orders={orders.slice(0, 8)} onStatusChange={setOrderStatus}/></div><div className="admin-panel"><div className="panel-heading"><div><h2>Recent customer feedback</h2><span>Live Firestore reviews</span></div><button onClick={() => setSection('Reviews')}>All reviews <ArrowRight size={14}/></button></div><ReviewsList reviews={reviews.slice(0, 5)} onModerate={moderateReview}/></div></>}
    {section === 'Products' && <><div className="admin-panel"><div className="panel-heading"><div><h2>Add a product</h2><span>Uploaded images and approved listings sync to the storefront.</span></div><PackagePlus size={19}/></div><form className="admin-product-form" onSubmit={addProduct}><label>Product name<input required value={name} onChange={(event) => setName(event.target.value)} maxLength={120}/></label><label>Brand / manufacturer<input value={brand} onChange={(event) => setBrand(event.target.value)} maxLength={100}/></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((option) => <option key={option}>{option}</option>)}</select></label><label>Retail price (GHS)<input required type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)}/></label><label>Available stock<input required type="number" min="0" step="1" value={stock} onChange={(event) => setStock(event.target.value)}/></label><label className="admin-field-wide admin-image-field"><span>Product image (source max 10 MB)</span><input id="admin-product-image" required type="file" accept="image/*" onChange={(event) => setImage(event.target.files?.[0] ?? null)}/><small>{image ? image.name : 'The image is compressed to fit safely in Firestore.'}</small></label><div className="admin-check-options"><label><input type="checkbox" checked={saleApproved} onChange={(event) => setSaleApproved(event.target.checked)}/> Approved for online sale</label><label><input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)}/> Publish to storefront</label><label><input type="checkbox" checked={prescriptionRequired} onChange={(event) => setPrescriptionRequired(event.target.checked)}/> Prescription required</label><label><input type="checkbox" checked={featured} onChange={(event) => setFeatured(event.target.checked)}/> Featured</label></div><p className="admin-form-note">A listing appears publicly only when both approval and publish are selected. Prescription-required products remain blocked from checkout.</p>{busy && <div className="admin-upload-progress" role="status"><span>{uploadStage === 'optimizing' ? 'Optimizing image for Firestore…' : 'Saving product and image to Firestore…'}</span><progress/></div>}<button className="button button-green" type="submit" disabled={busy || (publish && !saleApproved)}>{busy ? uploadStage === 'optimizing' ? 'Optimizing image…' : 'Saving product…' : <><ImagePlus size={16}/> Save product</>}</button></form></div><div className="admin-panel"><div className="panel-heading"><div><h2>Catalogue</h2><span>{products.length} live records, including drafts</span></div><RefreshCw size={17}/></div><div className="admin-product-list">{products.map((product) => <div className="admin-product-row" key={product.id}><img src={product.images?.[0]?.url ?? ''} alt=""/><div className="admin-product-description"><b>{product.name}</b><small>{product.sku} · {product.categoryName} · Stock {product.stock}</small></div><strong>{currency(product.retailPricePesewas)}</strong><span className={`admin-product-status ${product.publicationStatus === 'published' && product.onlineSaleApproved ? 'is-published' : ''}`}>{product.publicationStatus === 'published' && product.onlineSaleApproved ? 'Published' : 'Draft'}</span><button className="admin-small-action" onClick={() => void setProductPublished(product)}>{product.publicationStatus === 'published' ? 'Unpublish' : product.onlineSaleApproved ? 'Publish' : 'Approve & publish'}</button></div>)}{products.length === 0 && <p className="admin-empty-state">No products yet. Add one above to begin.</p>}</div></div></>}
    {section === 'Orders' && <div className="admin-panel"><div className="panel-heading"><div><h2>Order management</h2><span>Live orders, payments and status changes</span></div><RefreshCw size={17}/></div><OrdersTable orders={orders} onStatusChange={setOrderStatus}/></div>}
    {section === 'Reviews' && <div className="admin-panel"><div className="panel-heading"><div><h2>Customer feedback</h2><span>Moderate live review submissions</span></div><RefreshCw size={17}/></div><ReviewsList reviews={reviews} onModerate={moderateReview}/></div>}
    <p className="admin-disclaimer">Live data is read from the selected Firebase project. Product publication and order/review updates require deployed admin Firestore/Storage rules.</p></div></section></main>
}

function OrdersTable({ orders, onStatusChange }: { orders: AdminOrder[]; onStatusChange: (order: AdminOrder, status: string) => void }) {
  return <div className="admin-live-table-wrap"><table className="admin-live-table"><thead><tr><th>ORDER</th><th>DATE</th><th>ITEMS</th><th>PAYMENT</th><th>TOTAL</th><th>FULFILLMENT</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><b>{order.orderId || order.id}</b></td><td>{dateLabel(order.createdAt)}</td><td>{order.items?.reduce((sum, item) => sum + item.quantity, 0) ?? 0}</td><td><span className="admin-status-pill">{order.paymentStatus}</span></td><td>{currency(Number(order.totalPesewas ?? 0))}</td><td><select aria-label={`Set status for ${order.orderId}`} value={order.orderStatus} onChange={(event) => onStatusChange(order, event.target.value)}>{[...new Set([order.orderStatus, ...orderStatuses])].map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></td></tr>)}</tbody></table>{orders.length === 0 && <p className="admin-empty-state">No orders yet. Orders will appear here as soon as they are created.</p>}</div>
}

function ReviewsList({ reviews, onModerate }: { reviews: AdminReview[]; onModerate: (review: AdminReview, status: 'approved' | 'hidden') => void }) {
  return <div className="admin-review-list">{reviews.map((review) => <article className="admin-review-row" key={review.id}><div className="admin-review-meta"><b>{'★'.repeat(Math.max(0, Math.min(5, review.rating)))}</b><span>{review.status}</span><time>{dateLabel(review.createdAt)}</time></div><p>{review.text}</p><small>Product {review.productId} · Customer {review.customerId}</small><div className="admin-review-actions"><button onClick={() => onModerate(review, 'approved')}>Approve</button><button onClick={() => onModerate(review, 'hidden')}>Hide</button></div></article>)}{reviews.length === 0 && <p className="admin-empty-state">No customer feedback has been submitted yet.</p>}</div>
}
