import { useState, useEffect, useRef } from 'react';

export default function DropZone({ onDrop }) {
  const [active, setActive] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const handleDragEnter = (e) => {
      e.preventDefault();
      dragCounterRef.current++;
      setActive(true);
    };
    const handleDragLeave = () => {
      dragCounterRef.current--;
      if (dragCounterRef.current === 0) setActive(false);
    };
    const handleDragOver = (e) => e.preventDefault();
    const handleDrop = (e) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setActive(false);
      onDrop(e.dataTransfer.items);
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, [onDrop]);

  return (
    <div className={`drop-zone${active ? ' active' : ''}`}>
      <div className="drop-zone-text">Drop files or folders here</div>
    </div>
  );
}
