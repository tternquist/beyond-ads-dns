export function buildQueryParams({
  queryPage,
  queryPageSize,
  querySortBy,
  querySortDir,
  filterSearch,
  filterQName,
  filterOutcome,
  filterRcode,
  filterClient,
  filterQtype,
  filterProtocol,
  filterSinceMinutes,
  filterMinLatency,
  filterMaxLatency,
}) {
  const params = new URLSearchParams({
    page: String(queryPage),
    page_size: String(queryPageSize),
    sort_by: querySortBy,
    sort_dir: querySortDir,
  });
  if (filterSearch) params.set("q", filterSearch);
  if (filterQName) params.set("qname", filterQName);
  if (filterOutcome) params.set("outcome", filterOutcome);
  if (filterRcode) params.set("rcode", filterRcode);
  if (filterClient) params.set("client_ip", filterClient);
  if (filterQtype) params.set("qtype", filterQtype);
  if (filterProtocol) params.set("protocol", filterProtocol);
  if (filterSinceMinutes) params.set("since_minutes", filterSinceMinutes);
  if (filterMinLatency) params.set("min_duration_ms", filterMinLatency);
  if (filterMaxLatency) params.set("max_duration_ms", filterMaxLatency);
  return params;
}
