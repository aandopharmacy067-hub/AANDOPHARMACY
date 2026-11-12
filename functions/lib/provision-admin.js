"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("firebase-admin/app");
const auth_1 = require("firebase-admin/auth");
if ((0, app_1.getApps)().length === 0)
    (0, app_1.initializeApp)({ credential: (0, app_1.applicationDefault)() });
async function provisionAdmin() {
    const uid = process.argv[2];
    if (!uid) {
        console.error('Usage: node functions/lib/provision-admin.js <firebase-auth-uid>');
        process.exitCode = 1;
        return;
    }
    const auth = (0, auth_1.getAuth)();
    const user = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
    await auth.revokeRefreshTokens(uid);
    console.log(`Admin claim provisioned for ${user.uid}. The user must sign in again to refresh claims.`);
}
void provisionAdmin().catch(() => {
    console.error('Admin provisioning failed. Confirm the UID and privileged Firebase Admin credentials.');
    process.exitCode = 1;
});
