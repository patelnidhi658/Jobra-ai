// ============================================================
//  JOBRA AI - Stripe webhook (Supabase Edge Function)
//
//  Auto-activates and deactivates members when they pay, renew,
//  fail payment, or cancel. This is the ONLY server code needed
//  for self-serve subscriptions. It flips subscribers.status,
//  which the Jobra app already reads to grant or block access.
//
//  Deploy:
//    supabase functions deploy stripe-webhook --no-verify-jwt
//
//  Set these secrets (Supabase: Project Settings -> Edge Functions,
//  or `supabase secrets set ...`):
//    STRIPE_SECRET_KEY            (Stripe: Developers -> API keys)
//    STRIPE_WEBHOOK_SECRET        (Stripe: the signing secret for this endpoint)
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY    (Supabase: Settings -> API -> service_role)
//
//  Then in Stripe (Developers -> Webhooks) add an endpoint pointing to
//  this function's URL and subscribe to these events:
//    checkout.session.completed
//    customer.subscription.updated
//    customer.subscription.deleted
//    invoice.payment_failed
// ============================================================

import Stripe from "https://esm.sh/stripe@16?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Map a Stripe subscription status to our simple flag.
function flagFor(stripeStatus: string): string {
  if (stripeStatus === "active" || stripeStatus === "trialing") return "active";
  if (stripeStatus === "past_due" || stripeStatus === "unpaid") return "past_due";
  return "inactive"; // canceled, incomplete_expired, paused, etc.
}

async function setStatusByEmail(email: string, status: string, customerId?: string) {
  const row: Record<string, unknown> = { email: email.toLowerCase(), status };
  if (customerId) row.stripe_customer_id = customerId;
  await supabase.from("subscribers").upsert(row, { onConflict: "email" });
}

async function setStatusByCustomer(customerId: string, status: string) {
  await supabase.from("subscribers").update({ status }).eq("stripe_customer_id", customerId);
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature check failed: ${(err as Error).message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const email = s.customer_details?.email ?? s.customer_email ?? "";
        const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
        if (email) await setStatusByEmail(email, "active", customerId);
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await setStatusByCustomer(customerId, flagFor(sub.status));
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await setStatusByCustomer(customerId, "inactive");
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        if (customerId) await setStatusByCustomer(customerId, "past_due");
        break;
      }
    }
  } catch (err) {
    return new Response(`Handler error: ${(err as Error).message}`, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
