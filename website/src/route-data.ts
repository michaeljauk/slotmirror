import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// The 404 page is a normal Starlight page, so it gets a canonical address like every other page.
// A missing page has no canonical address, and search engines must not index it. Starlight gives
// its 404 route the id "404" in every locale.
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (route.id !== "404") return;
  route.head = route.head.filter(
    (tag) => tag.attrs?.rel !== "canonical" && tag.attrs?.property !== "og:url",
  );
  route.head.push({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
});
