import React from "react";

const LoaderNavbar: React.FC = () => {
  return (
    <nav
      className="relative w-full bg-transparent text-white font-semibold text-sm opacity-0 pointer-events-none"
      style={{ transform: "translateY(429.922px)" }}
    >
      <div className="max-w-screen-xl mx-auto py-4">
        <div className="grid grid-cols-3 items-center">
          <div className="text-center text-lg opacity-100">Glitch</div>
          <div className="flex justify-center items-center space-x-4">
            <div className="text-lg opacity-0 transform -translate-x-[560.328px]">GLITCH</div>
            <div className="text-lg">&amp;</div>
            <div className="text-lg opacity-0 transform translate-x-[568.312px]">GRIT</div>
          </div>
          <div className="flex justify-end items-center">
            <div className="flex flex-col justify-center items-center space-y-1 mr-4">
              <div className="w-6 h-0.5 bg-white"></div>
              <div className="w-6 h-0.5 bg-white"></div>
              <div className="w-6 h-0.5 bg-white"></div>
            </div>
            <div className="text-center text-lg opacity-100">Grit</div>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default LoaderNavbar;
