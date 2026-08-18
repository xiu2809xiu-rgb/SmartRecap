import { Link } from 'react-router-dom';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { Brand } from '../components/layout/Shells.jsx';
import { Icon } from '../components/ui.jsx';
import './notfound.css';

export default function NotFound() {
  return (
    <div className="notfound">
      <AuroraBackdrop variant="aurora" className="backdrop-fixed" opacity={0.5} />

      <header className="shell notfound-bar">
        <Brand />
      </header>

      <main className="shell notfound-main" id="main">
        <Mascot state="confused" size={280} />
        <p className="eyebrow">404</p>
        <h1>Rec could not find that page</h1>
        <p className="lede">
          The link may be out of date, or the material behind it was deleted. Your library is still where you left it.
        </p>
        <div className="row wrap gap-2 center">
          <Link to="/app" className="btn btn-primary">
            <Icon name="grid_view" size={18} />
            Go to your library
          </Link>
          <Link to="/" className="btn btn-ghost">
            Back to home
          </Link>
        </div>
      </main>
    </div>
  );
}
