/** Maximum pages to fetch to prevent runaway pagination */
const MAX_PAGES = 10;

/**
 * Auto-paginate an Octokit list endpoint. Fetches additional pages when
 * the result count equals per_page (indicating more data may exist).
 */
export async function paginateAll<T>(
  fetchPage: (page: number) => Promise<{ data: T[] }>,
  perPage = 100,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const allItems: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await fetchPage(page);
    allItems.push(...data);
    if (data.length < perPage) break;
  }
  return allItems;
}
