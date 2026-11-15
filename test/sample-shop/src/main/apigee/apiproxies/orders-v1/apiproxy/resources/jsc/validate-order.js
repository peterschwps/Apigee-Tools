// Checks a new order before it reaches the order service. Sets order.valid
// to "true" or "false" and, for an invalid order, order.error.
var maxItems = parseInt(context.getVariable('private.orders.max_items'), 10) || 50;

var order = null;
try {
  order = JSON.parse(context.getVariable('request.content'));
} catch (e) {
  // A body that is not JSON is reported below
}

var error = null;
if (!order || typeof order !== 'object') {
  error = 'The request body must be a JSON object.';
} else if (!order.customerId) {
  error = 'customerId is required.';
} else if (!Array.isArray(order.items) || order.items.length === 0) {
  error = 'An order needs at least one item.';
} else if (order.items.length > maxItems) {
  error = 'An order may contain at most ' + maxItems + ' items.';
} else {
  for (var i = 0; i < order.items.length; i++) {
    var item = order.items[i];
    if (!item || !item.sku || !(item.quantity > 0)) {
      error = 'Item ' + (i + 1) + ' needs a sku and a positive quantity.';
      break;
    }
  }
}

context.setVariable('order.valid', error === null ? 'true' : 'false');
if (error !== null) {
  context.setVariable('order.error', error);
}
