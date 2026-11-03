/**
 * 人物显示调色：校准原贴图偏低白点，保持色度差并限制高光，替代逐RGB通道推白。
 * 默认白点0.80、饱和度1.90、明度对比1.20；仅对纹理材质生效，不改变源PNG或启用光照。
 */
export class AvatarColorGrade {
  /** 无参数；向材质提供校正代码，输入输出均为线性RGB，中间在显示颜色域处理。 */
  static shader_code() {
    return `
      vec3 avatar_grade(vec3 linearColor) {
        vec3 source=clamp(sRGBTransferOETF(vec4(linearColor,1.0)).rgb,0.0,1.0);
        float light=dot(source,vec3(.2126,.7152,.0722));
        float peak=max(max(source.r,source.g),source.b);
        float saturation=(peak-min(min(source.r,source.g),source.b))/max(peak,.0001);
        // 贴图亮部本身集中在约0.76，校准白点时保持RGB通道之间的色差。
        float target=pow(clamp(light/.80,0.0,1.0),1.20)*.975;
        vec3 chroma=(source-vec3(light))*1.90;
        // 已经有明显色彩的眼睛与粉色部位少提亮，保留深浅层次。
        target=mix(target,light,smoothstep(.10,.55,saturation)*.72);
        // 只缩短色度向量以容纳高光，避免逐通道截白导致色相和饱和度突变。
        float high=max(max(chroma.r,chroma.g),chroma.b);
        float low=min(min(chroma.r,chroma.g),chroma.b);
        float fit=min(1.0,min((.99-target)/max(high,.0001),
          target/max(-low,.0001)));
        vec3 displayColor=clamp(vec3(target)+chroma*max(fit,0.0),0.0,.99);
        return sRGBTransferEOTF(vec4(displayColor,1.0)).rgb;
      }`
  }
}
