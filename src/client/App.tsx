import { lazy, Suspense } from 'react';
import { useRoute } from './router';
import { Home } from './screens/Home';
import { Join } from './screens/Join';
import { RoomScreen } from './screens/Room';
import { ToastHost } from './ui/toast';

const Lab = lazy(() => import('./screens/Lab'));

export function App() {
  const route = useRoute();
  let screen;
  switch (route.name) {
    case 'join':
      screen = <Join key={route.code} code={route.code} />;
      break;
    case 'room':
      screen = <RoomScreen key={route.code} code={route.code} />;
      break;
    case 'lab':
      screen = (
        <Suspense fallback={<div className="center-note">3D 장면을 불러오는 중…</div>}>
          <Lab />
        </Suspense>
      );
      break;
    default:
      screen = <Home />;
  }
  return (
    <>
      {screen}
      <ToastHost />
    </>
  );
}
