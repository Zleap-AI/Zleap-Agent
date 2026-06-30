/**
 * Shared cross-domain UI primitives. New code across the app should import layout
 * primitives from here (not from `components/manage`), so the management surface
 * conventions become the whole-app baseline.
 *
 * Implementation currently lives in `manage-ui`; these aliases give a stable,
 * domain-neutral import surface.
 */
export {
  ManagePageShell as PageShell,
  ManageSearchBar as SearchBar,
  ManageList as List,
  ManageListRow as ListRow,
  ManageSectionLabel as SectionLabel,
  ManageStatusBadge as StatusBadge,
  ManageDialog as FormDialog,
  ManageDialogFooterActions as DialogFooterActions,
  ManageDrawer as Drawer,
  ManageForm as Form,
  ManageField as FormField,
  ManageDetailGrid as DetailGrid,
  ManageDetailItem as DetailItem,
  ManagePreviewBlock as PreviewBlock,
  ManageSeparator as SectionSeparator,
} from '@/components/manage/manage-ui';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
export { EmptyState } from '@/components/ui/empty-state';
export { Spinner, LoadingState } from '@/components/ui/spinner';
export { Skeleton } from '@/components/ui/skeleton';
export { IconButton } from '@/components/ui/icon-button';
export { Chip } from '@/components/ui/chip';
