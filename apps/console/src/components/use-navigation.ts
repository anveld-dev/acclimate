import { useRouterState } from '@tanstack/react-router';
import type { NavigationState } from '../server/navigation-state';
export function useNavigation() {
  return useRouterState({
    select: (state) => state.matches[0]?.loaderData as NavigationState | undefined,
  });
}
