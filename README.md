# A & O Pharmacy

A React, TypeScript and Vite pharmacy storefront served by one Node/Express server, with Firebase Authentication/Firestore for app data and server-validated Paystack checkout/webhooks. The initial catalogue shown without Firebase configuration is sample-only and is never written to production.

## Current Implementation

Implemented in this workspace:

- Responsive retail/wholesale storefront, product search and category filters, product quick view and cart.
- Email/password registration, sign-in, email verification and password reset through Firebase Authentication.
- Published product reads from Firestore after Firebase configuration.
- Same-origin Express checkout API verifies Firebase ID tokens, recalculates trusted prices/stock, reserves inventory and generates human-readable order IDs.
- Paystack initialization uses a server-only secret. Signed webhooks and customer returns are independently verified, idempotent and update Firestore orders/payments/inventory.
- mNotify auth/order/payment SMS triggers are handled by the same Express server and remain opt-in/best-effort.
- Firestore rules block customer writes to trusted catalogue, stock, order totals and payment state.
- Protected `/admin` portal with the designated verified Firebase admin identity, realtime Firestore products/orders/reviews, image compression and storage inside product documents, storefront publication controls and review/order status actions.

Not yet implemented as production workflows: prescription upload/review and dispensing, customer order-history screens, wholesale pricing editor, full analytics, promotions/coupons, refunds, delivery integrations, email/SMS service, business-specific legal pages, and operational pharmacist approval. Prescription-only products are rejected by checkout. Do not launch until the missing workflows and Ghana-specific regulatory review are completed.

## Requirements

- Node.js 20 or later and one web host that supports private environment variables.
- A Firebase project with Authentication (Email/Password) and Firestore enabled. Product image upload does not require Firebase Storage.
- Paystack account configured for GHS, and the pharmacy's verified website domain.

## Local Development

1. Install packages: `npm install`.
2. Copy `.env.example` to `.env.local` and fill in the Firebase Web App values. These browser configuration values are not server secrets.
3. Copy `.env.server.example` to `.env.server` and configure private server values there.
4. Run `npm run dev`. The launcher starts Express on port 3001 and Vite on port 5173; Vite proxies `/api` requests to Express.
5. Run `npm run build` for the frontend production build.

Without Firebase values the app uses a clearly marked sample catalogue. Authentication and checkout remain unavailable; no payment is simulated.

## Firebase Setup

1. Create a Firebase project and register a Web App. Enable Email/Password sign-in.
2. In Firebase Authentication settings, add the local development host and `aandopharmacy.onrender.com` to Authorized domains so verification links can return to the app.
3. Create Firestore in production mode.
4. Copy `.env.example` to `.env.local`; set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID`. Product images are embedded in Firestore, so no Storage bucket is required for catalogue image uploads.
5. Set the Firebase project with `firebase use --add`.
6. Deploy rules and indexes before using the app: `firebase deploy --only firestore:rules,firestore:indexes`.
7. Deploy this repository to Render using the included `render.yaml` Blueprint. It creates a single Node web service named `aandopharmacy`, building from the repository root with `npm ci --include=dev && npm run build` and starting with `npm start`. If the existing service is not Blueprint-managed, set Root Directory to `.`, Build Command to `npm ci --include=dev && npm run build`, and Start Command to `npm start` in Render's Settings, then redeploy the latest commit. The start script also builds `dist/` if it is missing, but the explicit Build Command is still recommended.
8. In Render's Environment settings, set the Firebase Web App values `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, and `VITE_FIREBASE_APP_ID` from your local Firebase Web App config. These are public client config values embedded during the build; the ignored `.env.local` is not uploaded to Render. The project ID is declared in the Blueprint.
9. In Render's private Environment settings, enter `PAYSTACK_SECRET_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, and `MNOTIFY_API_KEY`. Use newly rotated Paystack/mNotify keys and a newly generated Firebase service-account JSON. Never commit these values or put them in `.env.local` or `VITE_*` variables.
10. In Firebase Authentication, add `aandopharmacy.onrender.com` to Authorized domains. In Paystack, configure the webhook URL as `https://aandopharmacy.onrender.com/api/payments/webhook`. Use test-mode keys and test events first, and confirm the Render health check `/api/health` is healthy.
11. The Render service uses its single origin for storefront, checkout, return verification, webhooks and SMS APIs. `PUBLIC_APP_URL` is set in `render.yaml` to `https://aandopharmacy.onrender.com`.

Never put the Paystack secret, mNotify key or Firebase service-account credentials in source control, `.env.local`, or any `VITE_*` setting. The browser cannot supply the Paystack callback URL, price, amount or payment status; the Express server owns those decisions. Credentials previously pasted into chat should be revoked and replaced before production deployment.

## Firestore Data Shape

- `users/{uid}`: `fullName`, `email`, `phone`, `accountStatus`, `wholesaleStatus`, timestamps and saved addresses. No admin role is stored in this document; the single designated admin is matched by verified Firebase Auth email in the rules.
- `products/{productId}`: product name, auto-generated SKU, category, price, stock, publication and approval fields, plus `images[0].url` containing a compressed WebP data URL (max 350 KB before base64 encoding). This Firestore-only image approach suits a small test catalogue; each product read also transfers its image, so use a dedicated image host for a larger catalogue.
- `wholesalePricing/{productId}`: `wholesalePricePesewas`, `wholesaleTiers[]` (`minQuantity`, `unitPricePesewas`) and `minimumWholesaleQuantity`. Rules allow reads only for approved wholesale accounts, explicitly open-access accounts and admins; checkout reads these records server-side.
- `categories/{categoryId}`: pharmacy-managed category metadata and publication status.
- `orders/{orderId}`: immutable price/item/address snapshot, `totalPesewas`, `paymentStatus`, `orderStatus`, reservation metadata and timestamps.
- `payments/{orderId}`: server-owned amount, GHS currency, provider reference, transaction ID and verified status.
- `inventoryMovements/{movementId}`: server-created stock movement history.
- `settings/commerce`: delivery fee (pesewas) and `wholesaleAccess` (`open` or `approved`). `settings/orderCounters_YYYYMMDD` stores per-day sequence state.
- `wholesaleApplications`, `reviews`, `notifications`, `activityLogs`, and `smsEvents`: access is limited by the shipped rules. SMS event records store status, campaign ID and only the recipient's last four digits, not the message body or full phone number.

All monetary database values are integers in pesewas. The checkout function calculates prices from Firestore and never uses browser-submitted price or total values. Add any additional composite indexes when extending queries.

## Admin Access

There is no admin password in source code and no separate public admin registration. The admin portal is restricted to the single Firebase Auth identity `aandopharmacy067@gmail.com`, and that account must have a verified email. After signing in on the storefront with that account, use the **Admin** button in the header to open `/admin`. Other Firebase accounts are denied by Firestore rules.

After changing the allowlist rules in this workspace, deploy them with `firebase deploy --only firestore:rules,firestore:indexes`. Then open `/admin` or sign in from the storefront with the designated account. The live portal reads the latest 200 products, 100 orders and 100 reviews from Firestore; product images are compressed and stored in Firestore. Only products marked approved for online sale and published are returned to the storefront, which listens for changes in realtime.

## Payment and Pharmacy Safeguards

- Checkout requires a signed-in, email-verified customer and validates current product state, price, quantity, wholesale status and delivery data on the server.
- Checkout reserves inventory transactionally for 30 minutes. Successful verified payment commits stock once; failed initialization/payment and expiry release reservations.
- Paystack callbacks and webhooks are not trusted as proof by themselves. Webhooks require the HMAC signature and the backend calls Paystack's verify endpoint before confirming payment.
- A verified payment received after reservation expiry is marked for refund review instead of consuming unreserved stock.
- SMS uses mNotify's Quick Bulk SMS endpoint. Customers must opt in at registration. Signup, login, order-received and verified-payment messages are sent only to a valid Ghanaian number; login SMS is limited to one per 15 minutes. SMS provider failures do not block authentication or order/payment processing. Campaign IDs and delivery status are recorded in the admin-only `smsEvents` collection.
- Paystack and mNotify secrets, plus Firebase Admin credentials, must be set as private environment variables on the Node host (or in ignored local `.env.server` for development). Never put them in `.env.local`, any `VITE_*` setting, or source control. The mNotify SMS API is now called by this same server.
- Prescription-required products are intentionally not purchasable through this checkout. Add an authorized pharmacist review and dispensing workflow before enabling them.
- Have the pharmacy validate product publication, licensing details, customer privacy, dispensing operations and all policies against applicable Ghana FDA, Pharmacy Council and data-protection requirements before launch.

## Testing

- Application build: `npm run build`.
- Server health check: `GET /api/health` reports whether Firebase and Paystack are configured without returning secret values.
- After signing in with the designated admin account and deploying rules, open `/admin`, upload a test product image, publish and approve it, then confirm it appears in the storefront. Create a test order and review and verify both appear in their live admin sections.
- Manually test sample search, category filters, retail/wholesale display, quantity changes, local cart persistence, account dialogs and mobile navigation.
- Before launch, use Paystack test mode to test stock contention, duplicate/invalid webhook signatures, webhook retries, amount/currency mismatch, failed/abandoned payments, expired reservations, unauthorized order reads, and non-admin access.
- The payment API needs `PAYSTACK_SECRET_KEY` and Firebase Admin credentials on the Node host. `/api/health` can confirm whether Paystack and Firebase project settings are present; it never exposes their values. If the endpoint returns “Payments are not configured”, set the host secret and restart the Node service.
- The source is configured for the Firebase project ID in the local web environment, but Firebase CLI access and deployment of the updated rules are required before live admin uploads and management operations can work.
