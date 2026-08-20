import { Component } from 'react';
import { Icon } from './ui.jsx';

/**
 * Stops one broken component from blanking the whole app.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which renders as a white page with no message anywhere — the error exists
 * only in the console, where nobody demoing the app is looking. That made a
 * crash in the coding agent indistinguishable from a crash in routing.
 *
 * `scope` names what failed so the message can say which part of the page is
 * gone, and the error text is shown rather than hidden: it is the only clue
 * available at that point, and a student who can read "X is not a function"
 * back to us is far better off than one looking at nothing.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the component stack in the console for anyone with devtools open.
    console.error(`[${this.props.scope ?? 'app'}] render failed`, error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <Icon name="error" size={26} />
        <div>
          <p className="crash-title">
            {this.props.scope ? `${this.props.scope} stopped working` : 'Something went wrong'}
          </p>
          <p className="crash-detail">{error.message || String(error)}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
