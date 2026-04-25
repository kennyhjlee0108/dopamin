import os
from typing import Optional
import stripe

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")
_PRICE_ID = os.getenv("STRIPE_PRICE_ID_PRO_MONTHLY", "")
_APP_URL  = lambda: os.getenv("APP_URL", "http://localhost:8000")

PRO_STATUSES = {"active", "trialing"}


async def create_or_get_customer(supabase, user_id: str, user_email: str = "") -> str:
    """Return existing stripe_customer_id or create a new Stripe customer."""
    try:
        res = supabase.table("user_profiles").select("stripe_customer_id").eq("id", user_id).execute()
        if res.data and res.data[0].get("stripe_customer_id"):
            return res.data[0]["stripe_customer_id"]
    except Exception:
        pass  # column may not exist yet if migrations haven't been run
    customer = stripe.Customer.create(
        email=user_email or None,
        metadata={"user_id": user_id},
    )
    supabase.table("user_profiles").upsert({
        "id": user_id,
        "stripe_customer_id": customer.id,
    }).execute()
    return customer.id


def create_checkout_session_url(customer_id: str, user_id: str) -> str:
    """Create a hosted Checkout Session and return its URL."""
    price_id = os.getenv("STRIPE_PRICE_ID_PRO_MONTHLY", "")
    app_url  = _APP_URL()
    session = stripe.checkout.Session.create(
        customer=customer_id,
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="subscription",
        metadata={"user_id": user_id},
        success_url=app_url + "/app?upgraded=true",
        cancel_url=app_url + "/app?checkout=canceled",
    )
    return session.url


def create_portal_session_url(customer_id: str) -> str:
    """Create a Billing Portal session and return its URL."""
    session = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=_APP_URL() + "/app",
    )
    return session.url


def get_user_id_by_customer(supabase, customer_id: str) -> Optional[str]:
    """Look up internal user_id from a Stripe customer_id."""
    res = (
        supabase.table("user_profiles")
        .select("id")
        .eq("stripe_customer_id", customer_id)
        .execute()
    )
    return res.data[0]["id"] if res.data else None


def _field(sub, key, default=None):
    """Get a field from a Stripe SDK object (v12+) or a raw webhook dict."""
    if isinstance(sub, dict):
        return sub.get(key, default)
    return getattr(sub, key, default)


def sync_subscription(supabase, user_id: str, sub) -> None:
    """Write subscription state to user_profiles from a Stripe Subscription object or dict."""
    status     = _field(sub, "status", "free")
    is_pro     = status in PRO_STATUSES
    period_end = _field(sub, "current_period_end")
    sub_id     = _field(sub, "id")
    supabase.table("user_profiles").upsert({
        "id":                              user_id,
        "stripe_subscription_id":          sub_id,
        "subscription_status":             status,
        "subscription_current_period_end": period_end,
        "is_pro":                          is_pro,
    }).execute()
