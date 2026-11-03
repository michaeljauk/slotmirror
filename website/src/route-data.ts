import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// The 404 page is a normal Starlight page, so it gets a canonical address like every other page.
// A missing page has no canonical address, and search engines must not index it. With more
// locales, a translated 404 page has an id such as "de/404".
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (route.id !== "404" && !route.id.endsWith("/404")) return;
  route.head = route.head.filter(
    (tag) => tag.attrs?.rel !== "canonical" && tag.attrs?.property !== "og:url",
  );
  route.head.push({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
});
