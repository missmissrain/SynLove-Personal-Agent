/**
 * 人物无光照材质：还原双眼精修中的肤色、睫毛和发丝遮罩，不依赖场景灯光。
 * 参数THREE为本机固定版本渲染库；info为材质；texture为原贴图；controls为嘴眼；motion为骨骼矩阵与发梢位移。
 */
import { AvatarColorGrade } from './AvatarColorGrade.js'

export class AvatarMaterial {
  /** 参数THREE/info/texture/controls/motion为渲染库、材质、贴图、嘴眼值及骨骼控制器。 */
  constructor(THREE, info, texture, controls, motion) {
    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: Boolean(texture), depthWrite: true,
      uniforms: {
        map: { value: texture }, hasMap: { value: Boolean(texture) },
        baseColor: { value: new THREE.Vector4(...info.color) },
        colorMode: { value: 2 },
        correction: { value: Boolean(info.faceCorrection) },
        vertexColor: { value: Boolean(info.vertexColor) },
        cleanUv: { value: new THREE.Vector2(...(info.cleanUv || [0, 0])) },
        lashUv: { value: new THREE.Vector2(...(info.lashUv || [0, 0])) },
        pose: controls, ...motion.uniforms,
      },
      vertexShader: `
        attribute vec3 blinkL, blinkR, mouth;
        attribute vec4 skin;
        attribute float lash;
        attribute vec2 hairUv, hairMask;
        attribute vec3 rest;
        attribute vec4 mouthColor;
        attribute vec4 jointIndices, jointWeights;
        attribute vec2 secondary;
        uniform vec3 pose;
        uniform sampler2D boneTexture;
        uniform float boneCount;
        uniform vec4 hairWind;
        varying vec2 vUv, vHairUv, vHairMask;
        varying vec4 vSkin;
        varying float vLash;
        varying vec3 vRest;
        varying vec4 vMouthColor;
        mat4 bone_matrix(float index) {
          float y=(index+.5)/boneCount;
          return mat4(texture2D(boneTexture,vec2(.125,y)),
            texture2D(boneTexture,vec2(.375,y)),
            texture2D(boneTexture,vec2(.625,y)),
            texture2D(boneTexture,vec2(.875,y)));
        }
        void main() {
          vUv=uv; vHairUv=hairUv; vHairMask=hairMask; vSkin=skin; vLash=lash; vRest=rest;
          vMouthColor=mouthColor;
          vec3 p=position+blinkL*pose.x+blinkR*pose.y+mouth*pose.z;
          p.xy+=mix(hairWind.xy,hairWind.zw,step(0.0,secondary.y))*secondary.x;
          mat4 skinMatrix=bone_matrix(jointIndices.x)*jointWeights.x+
            bone_matrix(jointIndices.y)*jointWeights.y+
            bone_matrix(jointIndices.z)*jointWeights.z+
            bone_matrix(jointIndices.w)*jointWeights.w;
          p=(skinMatrix*vec4(p,1.0)).xyz;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(p.x,p.z,-p.y,1.0);
        }`,
      fragmentShader: `
        uniform sampler2D map;
        uniform bool hasMap, correction, vertexColor;
        uniform vec4 baseColor;
        uniform int colorMode;
        uniform vec2 cleanUv, lashUv;
        uniform vec3 pose;
        varying vec2 vUv,vHairUv,vHairMask;
        varying vec4 vSkin;
        varying float vLash;
        varying vec3 vRest;
        varying vec4 vMouthColor;
        ${AvatarColorGrade.shader_code()}
        void main() {
          vec4 c=hasMap ? texture2D(map,vUv) : baseColor;
          if(vertexColor) c=vMouthColor;
          if(correction) {
            float r=clamp(pose.y*5.0,0.0,1.0);
            float l=clamp(pose.x*5.0,0.0,1.0);
            float corner=vHairMask.y*smoothstep(-.0555,-.0535,vRest.x)
              *(1.0-smoothstep(-.0465,-.0445,vRest.x))
              *smoothstep(.8595,.8625,vRest.z)*(1.0-smoothstep(.8735,.8775,vRest.z));
            c.rgb=mix(c.rgb,texture2D(map,vHairUv).rgb,max(vHairMask.x,corner)*r);
            vec3 clean=texture2D(map,cleanUv).rgb;
            float left=smoothstep(-.0002,.0006,vSkin.x)*(1.0-smoothstep(.0024,.0078,vSkin.x))*vSkin.y*l;
            c.rgb=mix(c.rgb,clean,left);
            float right=smoothstep(-.0002,.0006,vSkin.z)*(1.0-smoothstep(.0024,.0078,vSkin.z))*vSkin.w*r;
            c.rgb=mix(c.rgb,clean,right);
            vec3 line=mix(texture2D(map,lashUv).rgb,clean,smoothstep(.42,.62,vLash));
            float weight=smoothstep(-.08,.08,vLash)*(1.0-smoothstep(1.1,1.7,vLash))*vSkin.w*r;
            c.rgb=mix(c.rgb,line,weight);
          }
          if(c.a<.02) discard;
          // 原色与旧版模式仅用于独立验收页对照，生产默认新调色；原生线性色材质不重复处理。
          if(colorMode==1) c.rgb=(c.rgb*3.2)/(vec3(1.0)+2.2*c.rgb);
          if(colorMode==2 && hasMap) c.rgb=avatar_grade(c.rgb);
          gl_FragColor=c;
          #include <colorspace_fragment>
        }`,
    })
  }
}
