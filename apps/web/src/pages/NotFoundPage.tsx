import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>页面不存在</h1>
      </div>
      <div className="page-body" style={{ maxWidth: 460 }}>
        <div className="card stack">
          <p className="muted">这个地址没有对应的页面。常见情况是分享链接被截断了。</p>
          <Link className="btn btn-primary btn-block" to="/" style={{ textAlign: 'center' }}>
            返回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
