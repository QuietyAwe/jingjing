import { Redirect } from 'expo-router';

export default function Index() {
  // 默认进入 Onboarding 流程
  return <Redirect href="/(onboarding)/frequency" />;
}
