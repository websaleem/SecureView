// CloudFront Function (viewer-request) for the /categorize behaviour.
//
// WHAT IT STOPS. /categorize is unauthenticated by design — the extension holds
// no credential, and CloudFront signs the request to API Gateway at the edge.
// That is fine for reading, but every call spends a Bedrock Nova Pro
// invocation, so an open endpoint is an open tab on someone else's bill.
//
// Dropping Access-Control-Allow-Origin stopped a web page *reading* the answer.
// It did not stop a page *causing the spend*: a page can still issue
//
//     fetch(url, { mode: 'no-cors', method: 'POST', body: '...' })
//
// and the request is sent and billed even though the reply is opaque. Because
// each visitor's browser uses that visitor's own IP, the WAF's per-IP rate limit
// (300 per 5 minutes) never sees enough traffic from any single address to act.
// One busy hostile page therefore fans unlimited Bedrock cost across its
// audience.
//
// WHY CONTENT-TYPE IS THE CHECK. A no-cors request may only carry a
// CORS-safelisted Content-Type: text/plain, multipart/form-data or
// application/x-www-form-urlencoded. It can never send application/json. A page
// that asks for application/json leaves no-cors mode, which triggers a
// preflight, and the preflight fails because this endpoint answers with no CORS
// headers — so the request is never sent at all.
//
// The extension's service worker has host_permissions for this host, so it is
// not subject to CORS and sets the header freely. Every released version has
// sent exactly `Content-Type: application/json` since the first commit, so this
// check costs no extension release and breaks no installed copy.
//
// WHAT IT DOES NOT STOP. A scripted caller (curl, a bot) can set any header it
// likes. Nothing at this layer can tell that apart from the extension, because
// the extension genuinely holds no secret — that is the design. Such a caller
// is limited to its own addresses and is what the WAF rate limit is for. The
// vector closed here is the one that borrows innocent visitors' IPs, which the
// rate limit structurally cannot catch.
function handler(event) {
  var request = event.request;

  if (request.method !== 'POST') {
    return deny(405, 'method not allowed');
  }

  // Header names are lowercased by the CloudFront Functions runtime.
  var header = request.headers['content-type'];
  var value = header && header.value ? header.value : '';

  // Compare only the media type: a legitimate client may append parameters,
  // e.g. "application/json; charset=utf-8".
  var mediaType = value.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return deny(415, 'unsupported media type');
  }

  return request;
}

function deny(status, message) {
  return {
    statusCode: status,
    statusDescription: message,
    // No Access-Control-Allow-Origin, matching the origin's own behaviour:
    // a page must not be able to read this either.
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: 'no-store' },
    },
    body: JSON.stringify({ error: message }),
  };
}
