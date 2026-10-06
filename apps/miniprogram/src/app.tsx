import { PropsWithChildren } from 'react';
import './app.css';

function App({ children }: PropsWithChildren<unknown>) {
  // children 即当前页面，Taro 会在路由切换时替换它。
  return children;
}

export default App;
