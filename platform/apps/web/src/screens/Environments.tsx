import ResourcePage from './ResourcePage';
import { RESOURCE_PAGE_CONFIGS } from './resource-configs';
export default function Environments() {
  return <ResourcePage config={RESOURCE_PAGE_CONFIGS.environments} />;
}
