import ResourcePage from './ResourcePage';
import { RESOURCE_PAGE_CONFIGS } from './resource-configs';
export default function Incidents() {
  return <ResourcePage config={RESOURCE_PAGE_CONFIGS.incidents} />;
}
