// Kypria Technologies - Stripe Webhook Handler
// Handles payment events, customer onboarding, and email notifications

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client with SERVICE ROLE key
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

// ============================================
// HANDLE CHECKOUT SESSION COMPLETED
// ============================================
async function handleCheckoutCompleted(session) {
  const customerEmail = session.customer_details?.email || session.customer_email;
  
  console.log('Processing checkout for:', customerEmail);

  // 1. INSERT PAYMENT RECORD
  const { data: paymentData, error: paymentError } = await supabase
    .from('payments')
    .insert({
      stripe_session_id: session.id,
      stripe_customer_id: session.customer,
      customer_email: customerEmail,
      amount_total: session.amount_total,
      currency: session.currency || 'usd',
      payment_status: session.payment_status,
      product_name: session.metadata?.product_name || 'Kypria Product',
      metadata: session.metadata || {}
    })
    .select()
    .single();

  if (paymentError) {
    console.error('Payment insert error:', paymentError);
    throw paymentError;
  }

  console.log('Payment recorded:', paymentData.id);

  // 2. UPDATE OR CREATE CUSTOMER LINEAGE
  if (session.customer) {
    await updateCustomerLineage(
      session.customer,
      session.metadata?.referrer_id || null
    );
  }

  // 3. INITIALIZE ONBOARDING FLOW
  await initializeOnboarding(
    customerEmail,
    paymentData.id,
    session.metadata?.plan || 'basic'
  );

  // 4. SEND CONFIRMATION EMAIL
  await sendConfirmationEmail(customerEmail, session);
}

// ============================================
// UPDATE CUSTOMER LINEAGE
// ============================================
async function updateCustomerLineage(customerId, parentCustomerId = null) {
  const { data: existing } = await supabase
    .from('customer_lineage')
    .select('*')
    .eq('customer_id', customerId)
    .single();

  if (existing) {
    console.log('Customer lineage already exists:', customerId);
    return;
  }

  // Calculate depth and lineage path
  let depth = 0;
  let lineagePath = [customerId];

  if (parentCustomerId) {
    const { data: parent } = await supabase
      .from('customer_lineage')
      .select('depth, lineage_path')
      .eq('customer_id', parentCustomerId)
      .single();

    if (parent) {
      depth = parent.depth + 1;
      lineagePath = [...parent.lineage_path, customerId];

      // Update parent's total_descendants
      await supabase
        .from('customer_lineage')
        .update({ total_descendants: supabase.raw('total_descendants + 1') })
        .eq('customer_id', parentCustomerId);
    }
  }

  // Insert new customer lineage
  const { error } = await supabase
    .from('customer_lineage')
    .insert({
      customer_id: customerId,
      parent_customer_id: parentCustomerId,
      lineage_path: lineagePath,
      depth: depth,
      total_descendants: 0
    });

  if (error) console.error('Lineage insert error:', error);
}

// ============================================
// INITIALIZE ONBOARDING FLOW
// ============================================
async function initializeOnboarding(email, paymentId, planType) {
  // Determine total steps based on plan
  const flowSteps = {
    basic: 3,
    premium: 5,
    enterprise: 7
  };

  const totalSteps = flowSteps[planType] || 3;

  const { error } = await supabase
    .from('onboarding_flows')
    .insert({
      customer_email: email,
      payment_id: paymentId,
      flow_type: planType,
      current_step: 1,
      total_steps: totalSteps,
      status: 'active',
      metadata: { started_via: 'stripe_webhook' }
    });

  if (error) {
    console.error('Onboarding flow insert error:', error);
  } else {
    console.log(`Onboarding initialized for ${email} (${planType} plan)`);
  }
}

// ============================================
// SEND CONFIRMATION EMAIL (via Resend)
// ============================================
async function sendConfirmationEmail(email, session) {
  // TODO: Integrate with Resend API
  console.log(`📧 Sending confirmation email to: ${email}`);
  
  /* Example Resend integration:
  const resend = new Resend(process.env.RESEND_API_KEY);
  
  await resend.emails.send({
    from: 'support@kypria.llc',
    to: email,
    subject: 'Payment Confirmation - Kypria',
    html: `<h1>Thank you for your purchase!</h1>
           <p>Amount: $${(session.amount_total / 100).toFixed(2)}</p>`
  });
  */
}

// ============================================
// HANDLE PAYMENT INTENT SUCCEEDED
// ============================================
async function handlePaymentSucceeded(paymentIntent) {
  console.log('Payment succeeded:', paymentIntent.id);
  // Additional payment success logic here
}

// ============================================
// HANDLE SUBSCRIPTION CREATED
// ============================================
async function handleSubscriptionCreated(subscription) {
  console.log('Subscription created:', subscription.id);
  // Subscription-specific logic here
}
