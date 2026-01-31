import { useEffect, useRef, useState } from 'react';

interface VideoBackgroundProps {
  videoSources?: string[];
  posterSrc?: string; // Image to show while video loads
  fallbackGradient?: boolean;
  clarityMode?: 'default' | 'high';
}

export default function VideoBackground({
  videoSources = ['/videos/upscale.mp4'],
  posterSrc = '/videos/auth-poster.jpg',
  fallbackGradient = true,
  clarityMode = 'default'
}: VideoBackgroundProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const isHighClarity = clarityMode === 'high';

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      // Ensure video plays on mount
      const playVideo = async () => {
        try {
          await video.play();
        } catch (err) {
          console.warn('Video autoplay failed, waiting for user interaction:', err);
        }
      };
      playVideo();
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video && !videoSources[0]) return;
    const playVideo = async () => {
      try {
        await video?.play();
      } catch (err) {
        console.warn("Video autoplay failed on index change:", err);
      }
    };
    playVideo();
  }, [currentIndex, videoSources]);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-black">
      {/* Video Background */}
      <video
        key={`background-video-${currentIndex}`}
        ref={videoRef}
        className={`absolute inset-0 w-full h-full object-cover ${isHighClarity ? 'opacity-100' : 'opacity-60'}`}
        autoPlay
        loop={videoSources.length === 1}
        muted
        playsInline
        preload="auto"
        poster={posterSrc}
        onError={(event) => {
          console.warn(`Video playback error, currentSrc=${videoRef.current?.currentSrc}`, event);
        }}
        onEnded={() => setCurrentIndex((prev) => (prev + 1) % videoSources.length)}
      >
        <source src={videoSources[currentIndex]} type="video/mp4" />
        {/* We can add a .webm source here later for better compression */}
      </video>
      
      {/* Fallback Animated Gradient (visible if video fails or has low opacity) */}
      {fallbackGradient && (
        <div className="absolute inset-0 z-[-1] bg-gradient-to-br from-blue-950 via-slate-900 to-indigo-950 animate-gradient-shift" />
      )}
      
      {/* Blur/Dark Overlay for text readability */}
      {!isHighClarity && (
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      )}
    </div>
  );
}

