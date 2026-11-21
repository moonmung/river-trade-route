import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 함렛(Hahmlet) 가변 글꼴. 방장 PC 서버가 글꼴 파일도 함께 제공하므로 인터넷 없이도 보인다.
import '@fontsource-variable/hahmlet';
import './styles.css';
import './game.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
