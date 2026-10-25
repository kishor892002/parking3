# ParkEase – Vehicle Parking Management System

A clean, lightweight parking management website built with plain **HTML, CSS and JavaScript**. No frameworks and no build step. Parking data is saved in the browser with `localStorage`. An optional small Node server (no dependencies) adds **automatic payment check-out**: the vehicle is checked out by itself as soon as the customer's payment arrives.

## Features

- Dashboard with total, occupied and available slots plus today's revenue
- Park a vehicle with validation (duplicate numbers and taken slots are blocked)
- Visual slot map with three zones (Bike, Car, Truck / Van); click a slot to select it or check out
- Automatic fee calculation per started hour (minimum 1 hour)
- UPI payment QR generated for each bill with the **amount already filled in** (works with PhonePe and any UPI app)
- **Automatic check-out when the payment arrives** (needs the optional server, see below), with a demo mode to try it without real money
- One-click **PDF bill** (vehicle details + payment QR on the same page) and a **PDF receipt** after payment
- Printable receipt on check-out
- Search parked vehicles by number, owner or slot
- History tab with CSV export
- Responsive layout and automatic dark mode

## Rates

| Vehicle     | Slots | Rate (₹ / hour) |
|-------------|-------|-----------------|
| Bike        | A1–A8 | 15              |
| Car         | B1–B12| 30              |
| Truck / Van | C1–C4 | 60              |

Change rates and slot counts at the top of `script.js` (`RATES` and `ZONES`).

## Project structure

```
parking-management-system/
├── index.html
├── style.css
├── script.js
├── pdf.js            (small built-in PDF generator, no libraries)
├── qr.js             (small built-in QR code generator, no libraries)
├── qr-data.js        (original static QR, kept as a fallback)
├── assets/
│   └── payment-qr.jpg
├── server/
│   ├── server.js     (payment server, no dependencies, Node 18+)
│   └── .env.example  (settings template; copy to server/.env)
├── package.json
├── README.md
└── .gitignore
```

## Run locally

Just open `index.html` in any modern browser. Or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Payment QR (UPI)

At check-out the site builds a UPI QR for that exact bill, with the amount filled in, so the customer only scans and pays. Where the money goes is set at the top of `script.js`:

```js
const UPI = { id: '7754084726-4@ibl', name: 'RAJ MAURYA' };
```

This UPI ID contains a phone number. If you publish the repository publicly, it is public too.

**Without the server** (for example on GitHub Pages) the site cannot know when a UPI payment succeeds, so the cashier taps **Payment received** after seeing the PhonePe notification. For automatic check-out, run the server described next.

## Automatic check-out after payment

A website alone cannot see your bank. A payment gateway can, so the server asks the gateway for a single-use QR for each bill and checks whether it has been paid. When it has, the website shows "Payment successful" and checks the vehicle out without anyone pressing a button.

The server also serves the website, so you open the site from the server's address.

### 1. Try it in demo mode (no account, no money)

Requires Node.js 18 or newer (https://nodejs.org).

```bash
npm run demo
# open http://localhost:3000
```

Park a vehicle, click its slot, and press **Simulate payment (demo)**. The window changes to "Payment successful" by itself. A badge in the header shows "Auto-pay: demo mode".

### 2. Go live with Razorpay

1. Create a Razorpay account (https://dashboard.razorpay.com), complete KYC and make sure **UPI QR codes** are enabled for your account.
2. Under **Settings → API Keys** create a key. Use the `rzp_test_...` key first, `rzp_live_...` when ready.
3. Copy `server/.env.example` to `server/.env` and fill in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Never commit this file (it is already in `.gitignore`).
4. Start the server: `npm start`, then open http://localhost:3000. The badge now says "Auto-pay: on".
5. Test with one small real payment before relying on it. Money goes to the bank account linked in your Razorpay account, not to the UPI ID in `script.js`.

Optional: in Razorpay **Settings → Webhooks** add `https://<your-server>/api/webhook/razorpay` with the event `qr_code.credited` and put your secret in `RAZORPAY_WEBHOOK_SECRET`. The site works without it because the server also checks with Razorpay directly.

### 3. Put it online

Host the whole folder on any Node host that stays on (Render, Railway, a VPS), start command `npm start`, and set the same values from `.env` as environment variables on the host. GitHub Pages cannot run the server; a site served only from GitHub Pages falls back to the manual flow.

### Good to know

- Each QR is single-use, fixed to the bill amount and expires after 15 minutes. Closing the window cancels it.
- **Mark paid manually** is always available as a backup.
- Pending payments are kept in the server's memory, so restarting the server forgets unpaid QR codes. Paid check-outs are already saved in the browser.
- The server must be running and reachable; if it is not, the site silently uses the manual flow.
- The bill amount is calculated in the browser and sent to the server, which is fine for a single parking counter. For a public self-service kiosk, move the fee calculation to the server.

### Fallback QR image

`assets/payment-qr.jpg` / `qr-data.js` hold the original static QR. It is used only if the dynamic QR cannot be built (the customer then types the amount). To replace it, swap the JPG and rebuild the data file:

```bash
python3 - <<'PY'
import base64, struct
b = open('assets/payment-qr.jpg','rb').read()
# find JPEG width/height
i = 2
while i < len(b):
    m = b[i+1]
    if m in (0xC0, 0xC1, 0xC2):
        h, w = struct.unpack('>HH', b[i+5:i+9]); break
    i += 2 + struct.unpack('>H', b[i+2:i+4])[0]
open('qr-data.js','w').write("window.PAYMENT_QR = {\n  width: %d,\n  height: %d,\n  data: 'data:image/jpeg;base64,%s'\n};\n" % (w, h, base64.b64encode(b).decode()))
PY
```

## Upload to GitHub

1. Create an empty repository on https://github.com/new (name it `parking-management-system`; do not add a README there).
2. In a terminal, go into this folder and run:

```bash
git init
git add .
git commit -m "Initial commit: parking management system"
git branch -M main
git remote add origin https://github.com/<your-username>/parking-management-system.git
git push -u origin main
```

## Publish as a website (GitHub Pages)

1. Open the repository on GitHub, then **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
3. Choose branch **main** and folder **/ (root)**, then click **Save**.
4. After a minute your site is live at `https://<your-username>.github.io/parking-management-system/`.

## License

Free to use and modify.
