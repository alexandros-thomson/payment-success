// Kypria Technologies - Stripe Webhook Handler
// Handles payment events, customer onboarding, and email notifications

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    // Verify webhook signature
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Handle the event
  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(stripeEvent.data.object);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(stripeEvent.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

// Handle checkout session completed
async function handleCheckoutCompleted(session) {
  const { customer, customer_email, customer_details, amount_total, currency } = session;
  
  // Record payment in Supabase
  const { error: paymentError } = await supabase
    .from('payments')
    .insert({
      stripe_customer_id: customer,
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent,
      customer_email: customer_email || customer_details?.email,
      customer_name: customer_details?.name,
      product_name: session.line_items?.data[0]?.description || 'Kypria Product',
      amount: amount_total,
      currency: currency,
      status: 'completed',
      metadata: session.metadata
    });

  if (paymentError) console.error('Payment insert error:', paymentError);

  // Update or create customer lineage
  await updateCustomerLineage(customer, customer_email || customer_details?.email, amount_total);

  // Send confirmation email via Resend
  await sendConfirmationEmail(customer_email || customer_details?.email, session);

  // Initialize onboarding flow
  await initializeOnboarding(customer_email || customer_details?.email, session);
}

// Handle payment intent succeeded
async function handlePaymentSucceeded(paymentIntent) {
  console.log('Payment succeeded:', paymentIntent.id);
  // Additional payment success logic here
}

// Handle subscription created
async function handleSubscriptionCreated(subscription) {
  console.log('Subscription created:', subscription.id);
  // Subscription-specific logic here
}

// Update customer lineage table
async function updateCustomerLineage(customerId, email, amount) {
  const { data: existing } = await supabase
    .from('customer_lineage')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .single();

  if (existing) {
    // Update existing customer
    await supabase
      .from('customer_lineage')
      .update({
        total_lifetime_value: existing.total_lifetime_value + amount,
        purchase_count: existing.purchase_count + 1,
        last_purchase_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('stripe_customer_id', customerId);
  } else {
    // Create new customer lineage
    await supabase
      .from('customer_lineage')
      .insert({
        customer_email: email,
        stripe_customer_id: customerId,
        total_lifetime_value: amount,
        purchase_count: 1,
        first_purchase_date: new Date().toISOString(),
        last_purchase_date: new Date().toISOString(),
        onboarding_status: 'pending'
      });
  }
}

// Send confirmation email
async function sendConfirmationEmail(email, session) {
  // Implement Resend email integration
  console.log(`Sending confirmation email to: ${email}`);
  // TODO: Integrate with Resend API using support@kypria.llc
}

// Initialize onboarding flow
async function initializeOnboarding(email, session) {
  await supabase
    .from('onboarding_flows')
    .insert({
      customer_email: email,
      product_name: session.line_items?.data[0]?.description || 'Kypria Product',
      step_number: 1,
      step_name: 'Welcome',
      completed: false
    });
}
