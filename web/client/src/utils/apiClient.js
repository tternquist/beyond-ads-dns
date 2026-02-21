class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseErrorBody(response) {
  try {
    const body = await response.json();
    return body.error || body.message || `Request failed: ${response.status}`;
  } catch {
    return `Request failed: ${response.status}`;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
  });

  if (!response.ok) {
    const message = await parseErrorBody(response);
    throw new ApiError(response.status, message, null);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function get(url) {
  return request(url, { method: "GET" });
}

function post(url, body) {
  const options = { method: "POST" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return options.headers
    ? request(url, options)
    : request(url, { method: "POST" });
}

function put(url, body) {
  return request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(url, body) {
  const options = { method: "DELETE" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return request(url, options);
}

function postRaw(url, options = {}) {
  return request(url, { method: "POST", ...options });
}

export const api = { get, post, put, del, request, postRaw };
export { ApiError };
