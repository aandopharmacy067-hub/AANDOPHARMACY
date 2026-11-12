import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

if (getApps().length === 0) initializeApp({ credential: applicationDefault() })

async function provisionAdmin() {
  const uid = process.argv[2]
  if (!uid) {
    console.error('Usage: node functions/lib/provision-admin.js <firebase-auth-uid>')
    process.exitCode = 1
    return
  }
  const auth = getAuth()
  const user = await auth.getUser(uid)
  await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true })
  await auth.revokeRefreshTokens(uid)
  console.log(`Admin claim provisioned for ${user.uid}. The user must sign in again to refresh claims.`)
}

void provisionAdmin().catch(() => {
  console.error('Admin provisioning failed. Confirm the UID and privileged Firebase Admin credentials.')
  process.exitCode = 1
})
