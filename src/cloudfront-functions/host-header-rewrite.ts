/**
 * CloudFront Function JavaScript code that rewrites the Host header
 * to x-forwarded-host before forwarding the request to Lambda Function URL origins.
 *
 * This is necessary because CloudFront sets the Host header to the Function URL domain,
 * but Next.js needs the original host for routing and URL generation.
 */
export const HOST_HEADER_REWRITE_CODE = `
function handler(event) {
  var request = event.request;
  request.headers['x-forwarded-host'] = request.headers.host;
  return request;
}
`;
