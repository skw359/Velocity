import { useAppContext } from '../context/AppContext';

export default function GlobalLoader() {
  const { state } = useAppContext();

  return (
    <div className={`global-loader-overlay${state.globalLoaderVisible ? ' show' : ''}`}>
      <div className="loader"></div>
    </div>
  );
}
