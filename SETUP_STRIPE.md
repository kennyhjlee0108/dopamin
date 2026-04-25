# Stripe Setup (one-time manual steps)

## 1. Create Stripe account
Go to https://dashboard.stripe.com and sign up. Stay in **TEST mode** while developing (toggle in the top-left).

## 2. Get API keys
Dashboard → Developers → API keys
- Copy **Publishable key** → `STRIPE_PUBLISHABLE_KEY` in `.env`
- Copy **Secret key** → `STRIPE_SECRET_KEY` in `.env`

## 3. Create Product & Price
Dashboard → Products → **+ Add product**
- Name: `intime Pro`
- Description: `AI Study Friend, all sounds, calendar sync, full stats`
- Pricing model: **Recurring**, `$9.00 USD`, **Monthly**
- Save, then copy the **Price ID** (starts with `price_...`) → `STRIPE_PRICE_ID_PRO_MONTHLY` in `.env`

## 4. Run database migrations
In your Supabase dashboard → SQL Editor → paste and run the full `setup.sql` file (or just the `ALTER TABLE` block at the bottom if you already ran the initial setup).

## 5. Set up webhook (LOCAL DEV)
Install the Stripe CLI: https://stripe.com/docs/stripe-cli

```bash
brew install stripe/stripe-cli/stripe   # macOS
stripe login
stripe listen --forward-to localhost:8000/api/stripe/webhook
```

Copy the **webhook signing secret** it prints → `STRIPE_WEBHOOK_SECRET` in `.env`

Keep this terminal running while developing.

## 6. Set up webhook (PRODUCTION)
Dashboard → Developers → Webhooks → **+ Add endpoint**
- URL: `https://yourdomain.com/api/stripe/webhook`
- Events to send:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
  - `invoice.payment_succeeded`
- Save, copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET` in your production env

## 7. Configure Billing Portal
Dashboard → Settings → Billing → **Customer portal**
- Enable "Allow customers to cancel subscriptions"
- Enable "Allow customers to update payment methods"
- Save

## 8. Test cards (test mode only)
| Card number | Result |
|---|---|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 0002` | Card declined |
| `4000 0025 0000 3155` | Requires 3D Secure authentication |

Use any future expiry date and any 3-digit CVC.

## 9. Testing checklist
- [ ] Clicking "Get Pro" on a signed-in user redirects to Stripe Checkout
- [ ] Completing checkout with `4242` card redirects back with `?upgraded=true`
- [ ] Within ~5s, UI unlocks all Pro features (AI chat, custom durations)
- [ ] `GET /api/user/subscription` returns `is_pro: true`
- [ ] Canceling from Billing Portal triggers `customer.subscription.deleted` webhook
- [ ] Non-Pro users calling `/chat` get a `403` with `error: "pro_required"`
- [ ] Frontend catches the 403 and opens the upgrade modal
- [ ] `invoice.payment_failed` marks user as `past_due`
