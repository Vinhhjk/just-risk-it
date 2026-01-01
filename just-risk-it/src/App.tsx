import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { CrashGame } from './components/CrashGame';
import { VerifyGame } from './components/VerifyGame';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CrashGame />} />
        <Route path="/verify-game" element={<VerifyGame />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
