export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/live/index',
    'pages/leaderboard/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#1f2937',
    navigationBarTitleText: '基层赛事比分',
    navigationBarTextStyle: 'white',
    backgroundColor: '#0f172a',
  },
  /** 现场网络差，开启按需注入与分包无关的优化项。 */
  lazyCodeLoading: 'requiredComponents',
});
