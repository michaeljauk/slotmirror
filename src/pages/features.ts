import { createContext, useContext } from "hono/jsx";

/** Parts of the app that the deployment's settings turn on. `render` provides the values. */
const FeaturesContext = createContext({ tokens: false });

export const FeaturesProvider = FeaturesContext.Provider;

export function useFeatures() {
  return useContext(FeaturesContext);
}
